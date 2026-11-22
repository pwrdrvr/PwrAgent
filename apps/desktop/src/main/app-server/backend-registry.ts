import type { CheckoutToolHandler } from "../agent-tools/pwragent-resource-checkout-agent-tools";
import type { ThreadModelSettings } from "./thread-model-settings";
import type { AcpSessionRuntimeOptions } from "./acp-session-runtime-options";
import type { HeadlessAutomationTurns } from "./headless-automation-turns";
import type { TurnEventDelivery, TurnEventObservers } from "./turn-event-observer";
import { codexModelProviderPickerValue, providerPickerValue } from "@pwragent/shared/provider-picker";
import type { CodexRuntimeSupervisor } from "./codex-runtime-supervisor";
import type { RegistryContext } from "./registry-context";
import type { CodexStartDeliveryReceipt } from "./registry-turn-state";
import type { ForgeToolBridge } from "./forge-tool-bridge";
import type { ThreadInspectionTools } from "./thread-inspection-tools";
import type { ThreadMcpConnections } from "./thread-mcp-connections";
import type { ManagedReviewService } from "./managed-review-service";
import { isOnlyTaskMonitorWake, type SubAgentMonitorService } from "./subagent-monitor-service";
import type { ThreadUsageLedger } from "./thread-usage-ledger";
import type { ThreadArchiveCoordinator } from "./thread-archive-coordinator";
import type { RegistryReadThreadRequest } from "./registry-host-ports";
import type { ThreadWorkspaceService } from "./thread-workspace-service";
import type { ThreadDirectoryService } from "./thread-directory-service";
import { refuseResolvedWorkMode } from "./required-work-mode";
import { logUnpricedThreadUsageLine } from "./unpriced-usage-line-log";
import { logDebug } from "./registry-debug-log";
import type { RegistryDependencies } from "./backend-registry-construction";
import { assertOutpostCodexProvider, assertOwnerCodexModelSelection, assertOwnerExecutionPolicy, ownerSandboxForMode, type OwnerExecutionRequest } from "../owner-runtime-policy";
import { countAgentTools, filterAdvertisedAgentTools, isAgentToolCallAllowed } from "../headless/outpost-agent-tools";
import { localAgentToolAllowlist, localAgentToolRefusal, localMemberRole } from "../member-containment";
import { buildPwrAgentMessagingPdfToolRouter } from "../agent-tools/pwragent-messaging-agent-tools";
import { requestShowThread, ownerNotifications as getDesktopNotificationService, getOwnerHostServices } from "../owner-host";
import { ThreadCreationLifecycle, type PreparedThreadCreation, type ThreadCreationPreparation } from "@pwragent/owner-core/thread-creation-lifecycle";
import { buildTurnStartEvent, buildTurnStartFailureEvent, ThreadTurnStartLifecycle } from "@pwragent/owner-core/thread-turn-start-lifecycle";
import { ThreadInterruptionLifecycle } from "@pwragent/owner-core/thread-interruption-lifecycle";
import { ThreadSteeringLifecycle, type ThreadSteeringSubmission } from "@pwragent/owner-core/thread-steering-lifecycle";
import { ThreadSteerSubmissionLifecycle, type PreparedAcpSteer, type PreparedCodexSteer } from "@pwragent/owner-core/thread-steer-submission-lifecycle";
import { ThreadTitleLifecycle, extractFirstMeaningfulTextInput } from "@pwragent/owner-core/thread-title-lifecycle";
import {
  ThreadNamingLifecycle,
  type ThreadRenameOptions,
} from "@pwragent/owner-core/thread-naming-lifecycle";
import { projectOwnerThreadTitle, projectOverlayThreadTitle } from "@pwragent/owner-core/thread-title-projection";
import { ThreadOwnerUnavailableError, type ThreadOwnerAdmission } from "@pwragent/owner-core/thread-owner-admission";


import { NavigationDirectoryScope } from "@pwragent/owner-core/navigation-directory-scope";
import { delegatedTurnAttribution, withoutTurnAttribution } from "./delegated-turn-attribution";
import { resolveTurnInputSource, type TurnInputSource } from "@pwragent/owner-core/turn-input-source";
import { GET_CURRENT_TURN_INPUT_SOURCE, type CurrentTurnInputSourceHandler } from "../agent-tools/current-turn-input-source-tool";
import { SELF_STARTED_TURN_ENTRY_PREFIX } from "./thread-pending-wakes";
import type { LaunchpadCreationRequest, LaunchpadCreationResponse } from "@pwragent/shared/contracts/agent";
import type { ThreadTodoMessageTarget } from "@pwragent/shared/contracts/thread-todos";
import { ClaudeBackend, ClaudeTurnActiveError } from "../claude/claude-backend";
import { checkAgentAccessRequest, isAgentAccessRefusalMessage } from "../agent-tools/agent-access-ceiling";


import type { ClaudeSelfStartedTurnSource } from "../claude/claude-self-started-turns";
import type { ForgeReadHandler } from "../agent-tools/pwragent-forge-agent-tools";
import type { ForgePrToolHandler, ForgePrToolPreflight } from "../agent-tools/pwragent-forge-pr-agent-tools";
import type { ForgeReadRequest } from "../pr-status/forge-tool-contract";
import type { ThreadPrAutoDispatchPreferenceChange } from "../pr-status/pr-auto-dispatch";
import type { PrMetadataDemand } from "../pr-status/pr-metadata-process";
import {
} from "../pr-status/forge-pr-tool-contract";
import type { MaintenanceDiscoveryProgress } from "./unreferenced-worktrees";
import { PlanLimitStore, planLimitKey } from "./plan-limit-store";
import { buildPendingTurnId, isPendingTurnId } from "@pwragent/shared/turn-placeholder";
import { findAcpPermissionModeConfigOption } from "@pwragent/shared/acp-permission-mode";
import { lowerThreadExecutionMode } from "@pwragent/shared/thread-execution-mode";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import { TASK_MONITOR_TOOL_NAMESPACE } from "@pwragent/shared/contracts/task-monitor-tools";
import { type DesktopCheckoutHibernationPolicy } from "@pwragent/shared/checkout-hibernation-policy";
import {
  type DesktopThreadArchivePolicy,
  type DesktopThreadArchiveSweepStatus,
} from "@pwragent/shared/thread-archive-policy";
import { type ForgeAgentToolPolicy } from "@pwragent/shared/contracts/forge-agent-tools";
import { MCP_PROJECT_TOOL_APPROVAL_OFFER_META_KEY } from "@pwragent/shared/contracts/mcp-connections";
import type {
  ListBackgroundTerminalsRequest,
  ListBackgroundTerminalsResponse,
  TerminateBackgroundTerminalRequest,
  TerminateBackgroundTerminalResponse,
} from "@pwragent/shared/contracts/background-terminals";
import type { StoredProjectHeldWakeup } from "../storage/desktop-runtime-storage";
import type { StoredRestartContinuation } from "../storage/desktop-runtime-storage";
import type { RestartGateStatus } from "../../shared/restart-gate";
import {
  OPEN_RESTART_GATE,
  planRestartDispatch,
  restartContinuationSettles,
  transitionRestartGate,
  type RestartDispatchPlanOptions,
  type RestartGateEvent,
  type RestartGateState,
} from "./restart-continuation-gate";
import { supportsNativeVoice, type NativeVoiceBackend, type NativeVoiceToolCall } from "../codex-app-server/native-voice-protocol";
import type { NativeVoiceCapability } from "../../shared/native-voice";
import { analyzeUsageActivity, usageAnalysisModelBackend } from "./usage-activity-analysis";
import { codexModelProviderAccountKey, usageAccountKey } from "../usage-account-identity";

import { CodexModelProviderCatalog } from "./codex-model-provider-catalog";
import type { CodexProviderCatalogRetry } from "./codex-provider-catalog-retry";

import { withCodexRequestActivity } from "../codex-app-server/request-activity";

import { generateAcpStructuredObject, hasAcpStructuredHelper } from "./acp-structured-generation";
import {
  USAGE_ANALYSIS_MODEL_BACKENDS,
  type ReadUsageActivityRequest,
  type ReadUsageActivityResponse,
  type AnalyzeUsageActivityRequest,
  type AnalyzeUsageActivityResponse,
  type UsageLimitObservation,
} from "@pwragent/shared/contracts/usage-activity";
import { listingDiagnostics } from "../diagnostics/listing-diagnostics";
import { joinConcurrent } from "../../shared/concurrent-work";
import { publishedPrCommitShas } from "../../shared/pull-request-publication";
import {
  attributeCodexProviderUsageLine,
  withCodexProviderSnapshotRates,
  parseCodexProviderModelId,
  type CodexModelProviderSettings,
} from "@pwragent/shared/codex-model-providers";
import {
  isThreadLockRefusal,
  normalizeThreadLockNote,
  threadLockRefusalMessage,
} from "@pwragent/shared/thread-lock";
import { threadTodoMessageOriginFromUnknown } from "@pwragent/shared/contracts/thread-todos";
import {
  buildProjectPausedThreadMessageRefusal,
  buildProjectPausedWakeupDiscardNote,
  buildProjectPausedWakeupHoldReason,
  isProjectPausedThreadMessageRefusal,
  PROJECT_PAUSED_ERROR_CODE,
  projectRefusesThreadMessages,
  type ProjectHeldWakeup,
  type ProjectHeldWakeupSource,
  type ResolveProjectHeldWakeupsRequest,
  type ResolveProjectHeldWakeupsResponse,
} from "@pwragent/shared/project-forge-automation";
import { type ThreadPendingWakeHold } from "@pwragent/shared/contracts/thread-pending-wakes";
import {
  navigationWorkingStatePath as resolveThreadWorkingStatePath,
} from "@pwragent/shared/navigation-query-events";
import { type FederationTarget } from "@pwragent/shared/contracts/federation";
import {
} from "../pr-status/forge-reference";
import {
  projectThreadDisplay,
  readThreadSubAgentPanel,
  type ThreadSubAgentPanel,
} from "./thread-display";
import type { ReadQueuedTurnRequest, ReadQueuedTurnResponse } from "@pwragent/shared/contracts/agent";
import { buildIncomingWorkSummary } from "./thread-work-notification";
import { ThreadCorrespondenceStore } from "./thread-correspondence-store";
import { PendingEnvironmentLaunchStore } from "./pending-environment-launch-store";
import { mergeCausalMessagingContext } from "./causal-messaging-context";
import { rememberBoundedMap } from "../bounded-map";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { RetainedOwnerThreadStorage } from "@pwragent/owner-core/retained-owner-thread-storage";
import type {
  DynamicToolSpec as CodexDynamicToolSpec,
  ThreadStartParams as CodexThreadStartParams,
  ThreadSource as CodexThreadSource,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type {
  CodexProtocolCaptureResult,
  CodexProtocolCaptureStatus,
} from "../../shared/codex-protocol-capture";
import {
  resolveActiveProfileName,
} from "../profile";
import {
  createThreadSearchStorage,
} from "../storage/desktop-runtime-storage";
import type {
  ArchivedThreadAutomationRetirement,
  WorktreeGitWorkingStateCacheEntry,
} from "../storage/desktop-overlay-store";
import { materializeTranscriptImageEventForRenderer, toTranscriptImageProtocolUrl } from "../transcript-images";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";
import type { AcpMcpServerRegistration } from "../acp/acp-client";
import {
  buildManagedReviewContextInput,
} from "./managed-review";
import {
  buildCodexAgentInstructionUpdate,
  providerDeliveredAgentInstructions,
} from "../../shared/agent-instruction-delivery";
import { usageActivityScope } from "./overlay-transcript-entries";
import { pageNormalizedReplay } from "./thread-replay-pagination";
import {
  type AcpBackendId,
  type AppServerBackgroundTask,
  normalizeRenamedTitleSource,
  type ArchiveWorktreeRequest,
  type ArchiveWorktreeResponse,
  type ArchiveThreadRequest,
  type ArchiveThreadResponse,
  type AppServerListSkillsResponse,
  type AppServerNotification,
  type AppServerPendingRequestNotification,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type AppServerThreadImagePart,
  type AppServerThreadMessageOrigin,
  type AppServerThreadReviewEntry,
  type AppServerThreadReplay,
  type AppServerRenamedTitleSource,
  type AppServerThreadStatus,
  type AppServerThreadSummary,
  type AppServerTurnInputItem,
  type AppServerAvailableCommandSummary,
  type AppServerBackendKind,
  type AppServerBackendWake,
  type CodexThreadEnvironmentRuntime,
  type HandoffThreadWorkspaceRequest,
  type HandoffThreadWorkspaceResponse,
  type LinkedDirectorySummary,
  type RenameThreadRequest,
  type RenameThreadResponse,
  type RestoreWorktreeRequest,
  type RestoreWorktreeResponse,
  type MoveThreadToMainCheckoutRequest,
  type MoveThreadToMainCheckoutResponse,
  type RecreateThreadWorktreeRequest,
  type RecreateThreadWorktreeResponse,
  type ResolveMissingCodexThreadsRequest,
  type ResolveMissingCodexThreadsResponse,
  type RestoreThreadRequest,
  type RestoreThreadResponse,
  type AppServerToolRequestUserInputNotification,
  type ThreadExecutionMode,
  type ThreadHibernatedWorkspace,
  type ReadThreadWorktreeLockRequest,
  type ReadThreadWorktreeLockResponse,
  type RemoveLockedThreadWorktreesRequest,
  type RemoveLockedThreadWorktreesResponse,
  type WorktreeLockedKept,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  type NavigationLaunchpadAgent,
  type SetThreadLockResponse,
  type ThreadLock,
  type ThreadLockSource,
  type CodexEnvironmentOption,
  type EditGroupCommitInput,
  type EditGroupCommitState,
  type NavigationDirectoryGitStatus,
  type NavigationDirectorySummary,
  type NavigationLaunchpadDraft,
  type NavigationSnapshot,
  type NavigationThreadGitWorkingStateUpdatedNotification,
  type NavigationThreadSummary,
  type SetThreadTokenMiserRequest,
  type SetThreadTokenMiserResponse,
  type DetachThreadPullRequestRequest,
  type DetachThreadPullRequestResponse,
  type ThreadQueuedTurnSummary,
  type RefreshDirectoryGitStatusesRequest,
  type RefreshDirectoryGitStatusesResponse,
  type RefreshOwnedThreadGitWorkingStateRequest,
  type RefreshOwnedThreadPullRequestsRequest,
  type RefreshThreadGitWorkingStateResponse,
  type RefreshThreadPullRequestsResponse,
  type NavigationDirectoryGitStatusUpdatedNotification,
  type ThreadPermissionTransition,
  type ThreadQuestionnaireActivity,
  type ThreadTurnFailure,
  type ThreadAgentMetadata,
  type AcknowledgeThreadEnvironmentFailureRequest,
  type AcknowledgeThreadEnvironmentFailureResponse,
  type ThreadOverlayState,
  type ThreadSubAgentSummary,
  type PrSummary,
  type SetThreadCheckoutHibernationResponse,
  type NavigationLaunchpadDefaults,
  applyNavigationLaunchpadProviderSettingsPatch,
  buildThreadIdentityKey,
  navigationLaunchpadProviderKey,
  parseThreadIdentityKey,
  resolveDefaultLaunchpadExecutionMode,
  isAcpBackendId,
  isAppServerBackendKind,
} from "@pwragent/shared/contracts/navigation";
import {
  type PreviewThreadRewindRequest,
  type PreviewThreadRewindResponse,
  type RewindThreadRequest,
  type RewindThreadResponse,
  type UndoThreadRewindRequest,
  type UndoThreadRewindResponse,
  type AgentEvent,
  type AppServerCollaborationModeRequest,
  type CodexEnvironmentStartupFailure,
  type CodexEnvironmentSetupProgressEvent,
  type CancelQueuedTurnResponse,
  type MoveQueuedTurnRequest,
  type MoveQueuedTurnResponse,
  type SetQueuedTurnPausedRequest,
  type SetQueuedTurnPausedResponse,
  type ReleaseQueuedTurnResponse,
  type CheckThreadBranchDriftRequest,
  type CheckThreadBranchDriftResponse,
  type ConfigureGrokWorkflowBudgetRequest,
  type ConfigureGrokWorkflowBudgetResponse,
  type ControlActiveTurnRequest,
  type ControlActiveTurnResponse,
  type ControlActiveTurnErrorCode,
  type ForkThreadResponse,
  type LatestCodexConfigWarningResponse,
  type ListCodexMcpServersRequest,
  type ListCodexMcpServersResponse,
  type ListThreadMcpServersRequest,
  type ListThreadMcpServersResponse,
  type ReloadCodexMcpServersResponse,
  type ReloadCodexMcpServersRequest,
  type RemoveCodexMcpServerRequest,
  type RemoveCodexMcpServerResponse,
  type StartCodexMcpServerLoginRequest,
  type StartCodexMcpServerLoginResponse,
  type MaterializeDirectoryLaunchpadRequest,
  type MaterializeDirectoryLaunchpadOptions,
  type MaterializeDirectoryLaunchpadResponse,
  type ResetDirectoryLaunchpadRequest,
  type ResetDirectoryLaunchpadResponse,
  type RetainThreadBranchDriftRequest,
  type RetainThreadBranchDriftResponse,
  type RunCodexEnvironmentActionRequest,
  type RunCodexEnvironmentActionResponse,
  type StopCodexEnvironmentActionRequest,
  type StopCodexEnvironmentActionResponse,
  type SetCodexThreadEnvironmentRequest,
  type SetCodexThreadEnvironmentResponse,
  type SetAcpSessionRuntimeOptionRequest,
  type SetAcpSessionRuntimeOptionResponse,
  type ReloadCodexMcpConfigRequest,
  type ReloadCodexMcpConfigResponse,
  type SetThreadExecutionModeRequest,
  type SetThreadExecutionModeResponse,
  type SetThreadModelSettingsRequest,
  type SetThreadModelSettingsResponse,
  type SetThreadPrAutoDispatchRequest,
  type SetThreadPrAutoDispatchResponse,
  type CancelThreadPrAutoDispatchRequest,
  type CancelThreadPrAutoDispatchResponse,
  type SendThreadPrAutoDispatchNowRequest,
  type SendThreadPrAutoDispatchNowResponse,
  type ApplyThreadModelMigrationRequest,
  type ApplyThreadModelMigrationResponse,
  type TurnOffCodexFastEverywhereResponse,
  type QueueThreadExecutionModeRequest,
  type QueueThreadExecutionModeResponse,
  type CancelThreadExecutionModeQueueRequest,
  type CancelThreadExecutionModeQueueResponse,
  type SteerTurnRequest,
  type SteerTurnResponse,
  type StartTurnResponse,
  type ContinueThreadEnvironmentStartupRequest,
  type ContinueThreadEnvironmentStartupResponse,
  type StartReviewRequest,
  type StartReviewResponse,
  type StartThreadRequest,
  type StartThreadResponse,
  type DismissFailedSubAgentsRequest,
  type DismissFailedSubAgentsResponse,
  type StopSubAgentRequest,
  type StopSubAgentResponse,
  type SubmitServerRequestRequest,
  type SubmitServerRequestResponse,
  type TrustCodexProjectRequest,
  type TrustCodexProjectResponse,
  type UpdateDirectoryLaunchpadRequest,
  type UpdateDirectoryLaunchpadResponse,
  type UpdateThreadExpectedBranchRequest,
  type UpdateThreadExpectedBranchResponse,
  type EnsureDirectoryLaunchpadRequest,
  type EnsureDirectoryLaunchpadResponse,
} from "@pwragent/shared/contracts/agent";
import { buildPrependPinRank } from "@pwragent/shared/thread-pins";
import { buildThreadMarkdownLink, buildThreadUrl } from "@pwragent/shared/contracts/thread-link";
import { parseClaudeSubAgentTranscriptThreadId } from "@pwragent/shared/subagent-kind";
import { shortenDerivedThreadTitle } from "@pwragent/shared/thread-titles";
import { type FederationInstanceId, federatedThreadIdentityKey } from "@pwragent/shared/contracts/federation";
import {
  type InspectTokenMiserOutputRequest,
  type InspectTokenMiserOutputResponse,
  type AnalyzeThreadToolHistoryRequest,
  type AnalyzeThreadToolHistoryResponse,
  toolOutputWarningChars,
} from "@pwragent/shared/contracts/tool-output-incidents";
import {
  type BackendAccountSummary,
  type BackendAcpSessionRuntimeState,
  type BackendLaunchpadOptions,
  type BackendModelOption,
  type BackendRateLimitSummary,
  type BackendSummary,
  type CodexModelProviderCatalogState,
  type CodexAppServerRestartResult,
  type CodexAppServerRestartStatus,
  type ListBackendsRequest,
  type ListBackendsResponse,
  type StartupProviderRefreshStatus,
} from "@pwragent/shared/contracts/backend";
import {
  type CreateScheduledThreadActionRequest,
  type ScheduledThreadActionMutationResponse,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import {
  type DesktopProviderModelDefaults,
  type DesktopProviderThreadModelMigration,
  type DesktopSpendAlertPolicy,
  type DesktopToolOutputAlertPolicy,
  DESKTOP_SPEND_ALERT_POLICY_DEFAULT,
  DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT,
} from "@pwragent/shared/contracts/settings";
import { isBranchDrifted } from "@pwragent/shared/contracts/branch-drift";
import {
  type ReadThreadMcpConnectionsRequest,
  type DescribeThreadMcpConnectionsRequest,
  type DescribeThreadMcpConnectionsResponse,
  type SetThreadMcpConnectionsRequest,
  type SetThreadMcpConnectionsResponse,
} from "@pwragent/shared/contracts/mcp-connections";
import {
  type MutateThreadParentV1Request,
  type PwrAgentThreadInspectionResponse,
} from "@pwragent/shared/contracts/thread-tools";
import {
  type PwrAgentThreadOrchestrationRequest,
  type PwrAgentThreadOrchestrationResponse,
  type HandoffTaskResult,
} from "@pwragent/shared/contracts/thread-orchestration-tools";
import { type ThreadUsageLineRecord } from "@pwragent/shared/token-usage-pricing";
import {
  type ThreadMaintenanceRunStage,
  type ThreadMaintenanceRunItem,
} from "@pwragent/shared/thread-maintenance";
import {
  buildPendingRequestResponse,
  type PendingRequestApprovalContext,
} from "@pwragent/shared/pending-request-response";
import { resolveThreadParentKey } from "@pwragent/shared/subthreads";
import { readCodexEnvironmentActionRuns } from "@pwragent/shared/codex-environment-action-runs";
import {
  resolveHelperModel,
  type DesktopHelperModelSettings,
  type DesktopTaskMonitorModelChoice,
  type HelperModelId,
} from "@pwragent/shared/helper-models";
import { PWRAGENT_MESSAGING_PDF_TOOL_CATALOG_VERSION } from "@pwragent/shared/contracts/messaging-tools";
import { type AgentToolCatalogId } from "@pwragent/shared/contracts/agent-tools";
import { permissionForDynamicTool, type MessagingDynamicToolCategory } from "@pwragent/shared/contracts/rbac";
import { type TaskMonitorUsageSnapshot } from "@pwragent/shared/contracts/task-monitor-tools";
import {
  AcpBackendAdapter,
  acpSessionToThreadSummary,
  findAcpModelConfigOption,
  findAcpThoughtLevelConfigOption,
  inputToAcpPrompt,
  acpAdvertisesRuntimeModeSelector,
  isAcpSessionMissingForProjectError,
  mergeAcpRuntimeState,
  readKimiYoloExecutionModeFromText,
  withAcpModelRuntimeSelection,
  type AcpRuntimeClient,
  type AcpSessionMetadata,
} from "./acp-backend-adapter";
import {
  CodexThreadBusyBeforeStartError,
  extractRateLimitSummaries,
  type CodexPwrdrvrTokenMiserActivation,
  type CodexServerCapabilities,
} from "../codex-app-server/desktop-client";
import {
  type CodexAppServerProcessSample,
  type CodexAppServerRecycleSettings,
  type CodexAppServerRecycleStatus,
} from "../codex-app-server/app-server-recycle-policy";
import { isCodexInvalidResponseMessageIdError } from "../codex-app-server/invalid-response-message-id-recovery";
import type { CodexAppServerGenerationPromotion } from "../codex-app-server/app-server-generation-pool";
import { codexVersionFromUserAgent } from "../codex-app-server/protocol-compatibility";
import { ProviderTranscriptThreadSearchAdapter } from "../thread-search/thread-search-provider-adapters";
import { OwnerContentSearch } from "../thread-search/owner-content-search";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import {
  handleAutomationInspectionDynamicToolCall,
  isAutomationInspectionDynamicToolCall,
  type AutomationInspectionHandler,
} from "../automations/automation-inspection-codex-tools";
import {
  handleTaskMonitorDynamicToolCall,
  isTaskMonitorDynamicToolCall,
  readTaskMonitorDynamicToolCall,
} from "./task-monitor-codex-tools";
import {
  handlePwrAgentAppDynamicToolCall,
  isPwrAgentAppDynamicToolCall,
} from "../agent-tools/pwragent-app-codex-tools";
import type { PwrAgentAppManagementHandler } from "../agent-tools/pwragent-app-agent-tools";
import {
  agentToolPermissionDeniedMessage,
  appManagementActorDenial,
  appManagementDenial,
} from "../agent-tools/app-management-authorization";
import {
  handlePwrAgentThreadDynamicToolCall,
  isPwrAgentThreadDynamicToolCall,
} from "../agent-tools/pwragent-thread-codex-tools";
import {
  type PwrAgentFederatedThreadInspectionHandler,
  type PwrAgentFederatedThreadMutationHandler,
  type PwrAgentThreadInspectionHandler,
} from "../agent-tools/pwragent-thread-agent-tools";
import {
  handlePwrAgentMessagingDynamicToolCall,
  isPwrAgentMessagingDynamicToolCall,
} from "../agent-tools/pwragent-messaging-codex-tools";
import {
  type PwrAgentMessagingHandler,
} from "../agent-tools/pwragent-messaging-agent-tools";
import {
  PwrAgentFederatedThreadMessageError,
  type PwrAgentFederatedThreadControlHandler,
  type PwrAgentFederatedThreadMessageHandler,
  type PwrAgentThreadOrchestrationHandler,
} from "../agent-tools/pwragent-thread-orchestration-agent-tools";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools";
import type { PwrAgentStarMapHandler } from "../agent-tools/pwragent-star-map-agent-tools";
import {
  type PwrAgentThreadTodoHandler,
} from "../agent-tools/pwragent-thread-todo-agent-tools";
import type { PwrAgentOpenAIDecisionsHandler } from "../agent-tools/pwragent-openai-decisions-agent-tools";
import { ThreadTodoError } from "../thread-todos/thread-todo-service";
import type { DynamicToolPermissionCheck, MessagingAgentToolService } from "../messaging/messaging-agent-tool-service";

import { buildAutomationMcpConsent, isMcpToolApproval } from "../mcp-connections/mcp-approval-consent";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import {
  buildStarMapIntakeAgentTools,
  type StarMapIntakeAgentOutcome,
} from "./star-map-intake-agent";
import {
  AgentToolRouter,
  readAgentDynamicToolCall,
  toDynamicToolResponse,
} from "../agent-tools/agent-tool-router";
import { buildTokenMiserToolDefinitions } from "../agent-tools/token-miser-agent-tools";
import {
  buildPwrAgentToolSearchDefinition,
  MESSAGING_EAGER_TOOLS,
  VOICE_MANAGER_EAGER_TOOLS,
  withPwrAgentToolDiscovery,
} from "../agent-tools/pwragent-tool-search";
import { buildMcpGatewayToolDefinitions } from "../agent-tools/pwragent-mcp-gateway-tools";
import { researchToolsOffered, researchToolSurface, type ResearchAgentHandler, type ResearchToolSurface } from "../agent-tools/pwragent-research-agent-tools";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { agentToolFailure, agentToolSuccess } from "../agent-tools/agent-tool-definition";
import type { MessagingWorkingUpdatesHandler } from "../agent-tools/messaging-working-updates-agent-tools";
import type { DesktopSettingsService } from "../settings/desktop-settings-service";
import { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import {
  TokenMiserHookBridge,
} from "../token-miser/token-miser-hook-bridge";
import { TokenMiserPluginManager } from "../token-miser/token-miser-plugin-manager";
import {
  TOKEN_MISER_ACTIVATION_FILENAME,
  type TokenMiserActivationStatus,
} from "../token-miser/token-miser-types";
import { TokenMiserDiagnostics } from "../token-miser/token-miser-diagnostics";
import { TokenMiserService } from "../token-miser/token-miser-service";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import {
  type AgentToolMcpClientContext,
  type AgentToolMcpRegistration,
  type AgentToolMcpServerLike,
  type ResolvedAgentToolMcpCallContext,
} from "../agent-tools/agent-tool-mcp-server";

import { CodexProtocolCaptureSession } from "../diagnostics/codex-protocol-capture";


import type { ProtocolCaptureStore } from "../testing/capture-store";
import {
  GitDirectoryService,
} from "./git-directory-service";
import type {
  DirectoryGitStatusEntry,
  WorktreeBaseSource,
} from "./git-directory-service";
import { GitWorkingStateService } from "./git-working-state-service";
import type {
  GitWorkingStateEntryOptions,
  ResolveEditCommitStatesOptions,
  WorktreeWorkingStateEntry,
} from "./git-working-state-service";
import {
  ThreadInfoStore,
  type ThreadInfo,
  type ThreadInfoIdentity,
} from "./thread-info-store";
import {
  type ProviderThreadSnapshotStorage,
} from "@pwragent/owner-core/provider-thread-snapshot-storage";
import type { GitReadRequest } from "../git-info/read-cache";
import {
  BACKGROUND_WORKTREE_WORKING_STATE_BATCH_SIZE,
  selectStaleWorktreeWorkingStatePaths,
} from "./thread-working-state-refresh-policy";
import type { AcpAvailableCommandsStorage } from "@pwragent/owner-core/acp-storage";
import { WorktreeArchiveService } from "./worktree-archive-service";
import { WorktreeRecoveryService } from "./worktree-recovery-service";

import { CheckoutPathOwners } from "./checkout-path-owners";
import { type ThreadArchiveCandidate } from "./thread-archive-sweeper";

import { analyzeNormalizedToolReplay } from "./tool-output-replay-analyzer";
import {
  type ThreadTitleAdapterResult,
} from "@pwragent/owner-core/thread-title-generation-service";


import { getMainLogger } from "../log";
import {
  getDesktopSettingsService,
} from "../settings/desktop-settings-singleton";
import {
  assertProviderDiscoveryPermit,
  type ProviderDiscoveryPermit,
} from "../settings/provider-discovery-permit";
import {
  PROVIDER_IDS,
  providerLastKnownGoodMatchesConfig,
  type ConfigDomainMap,
  type ProviderId,
} from "../settings/config-store/config-domains";

import {
  type ManagedCodexSelectionChange,
} from "../settings/desktop-settings-service";
import { buildApprovalIntent } from "../messaging/core/messaging-approval-renderer";
import {
  BackendModelCatalog,
  type BackendModelCatalogCallerReason,
} from "./backend-model-catalog";
import {
  listCodexEnvironmentOptions,
} from "./codex-environment-config";
import { assertThreadModelSettingsAvailable } from "./thread-model-admission";
import { setupVariablesForAgent } from "./agent-setup-variables";
import {
  CodexEnvironmentStartupError,
} from "./codex-environment-runtime";
import {
  isSteerableAgentTraffic,
  ThreadTurnQueue,
  ThreadTurnQueueDispatchRefused,
  type ThreadTurnQueueEntry,
  type ThreadTurnQueueLifecycleEvent,
  type ThreadTurnQueueOrigin,
  type ThreadTurnQueueImmediateSubmissionResult,
  type ThreadTurnQueueSubmissionResult,
} from "@pwragent/owner-core/thread-turn-queue";
import {
  getProjectForgeAutomationIndex,
  summarizeProjectHeldWakeup,
  type ProjectForgeAutomationResolution,
} from "./project-forge-automation-index";
import {
  QueuedMessageTitler,
  queuedMessageTitleContext,
  queuedMessageTitleSource,
  type QueuedMessageTitleRequest,
  type QueuedMessageTitleSettlement,
} from "./queued-message-title";
import { deleteThreadAssets, type ThreadAssetOwner } from "./thread-assets";
import { AgentMemoryError, AgentMemoryStore } from "./agent-memory-store";
import {
  buildAgentMemoryContext,
  isAgentMemoryRead,
  type AgentMemoryArgs,
  type AgentMemoryRequest,
  type AgentMemoryResult,
} from "@pwragent/shared/contracts/agent-memory";
import { enrichLocalFileInputs } from "./local-file-input";
import {
  portableTurnInputAttachments,
  stageQueuedFileInputs,
  ownThreadInputAttachments,
  stageTurnInputAttachmentsForRetention,
} from "./turn-input-attachment-files";
import {
  PdfAttachmentStore,
  type PendingPdfAttachment,
} from "../pdf/pdf-attachment-store";
import {
  handlePwrAgentPdfToolRequest,
} from "../pdf/pwragent-pdf-agent-tools";
import {
  preparePdfTurnInput,
  type PdfTurnInputHandling,
} from "../pdf/pdf-turn-input-preparation";
import {
  ATTENTION_NOTIFICATION_METHODS,
  acpRuntimeHasExecutionModeSelection,
  buildHeadlessAutomationRequestCancelResponse,
  completedAtFromTerminalNotification,
  errorMessageFromTerminalNotification,
  fileChangeApprovalContextKey,
  formatExecutionModeForError,
  isAcpPermissionRequest,
  isAppServerThreadStatus,
  messagingDynamicToolCategoryForCatalog,
  pendingRequestDecisionFromMessagingApproval,
  questionnaireAnswerHasValue,
  queuedTurnDisplayText,
  queuedTurnPauseParams,
  readFileChangeApprovalFile,
  readNotificationProjectLabel,
  readStatusType,
  readTurnStatus,
  sanitizeQuestionnaireResponseForOverlay,
  turnIdFromStartedNotification,
  turnIdFromTerminalNotification,
} from "./backend-registry-notifications";
import {
  type AcceptedActiveTurnControlRequest,
  type AcceptedDynamicToolCall,
  type AcceptedThreadControlRequest,
  type AgentThreadActions,
  type ArchivedWorktreeRepairReport,
  type BackendClient,
  type BackendRegistryForkThreadRequest,
  type BackendRegistryMcpConnectionService,
  type BackendRegistryOverlayStoreLike,
  type CodexDiscoveryObserver,
  type CodexRetryableCompaction,
  type CodexRetryableTurnStart,
  type CreatedThreadDirectoryVisibility,
  type CreatedThreadVisibilityRow,
  type DirectoryGitStatusWriter,
  type ForgeToolRuleWriter,
  type HandoffSourceSettings,
  type LocalPullRequestAuthorityResolver,
  type McpProjectToolApprovalCardOffer,
  type MessagingArchiveCleaner,
  type MessagingArchiveCleanupStore,
  type ModelSettings,
  type ObservedCodexSettings,
  type PendingServerRequest,
  type PendingThreadMessageContext,
  type ProjectForgeAutomationHandler,
  type ProjectHeldWakeupStoreLike,
  type PullRequestReferenceResolver,
  type QuietRestartTarget,
  type QuitThreadSource,
  type RestartContinuationStoreLike,
  type AgentCreatedThreadObserver,
  type StartingTurnOrigin,
  type StartupProviderThreadRefresh,
  type ThreadGitWorkingStateRefreshHandler,
  type ThreadListCacheHit,
  type ThreadListCacheState,
  type ThreadListCallerReason,
  type ThreadMaintenanceToolHandler,
  type ThreadPrAutoDispatchHandler,
  type ThreadPrWatchesPeerHandler,
  type ThreadPullRequestCanonicalizer,
  type ThreadPullRequestDetachHandler,
  type ThreadPullRequestRefreshHandler,
  type ThreadPullRequestStatusToolHandler,
  type ThreadPullRequestWatchToolHandler,
  type ThreadTitleGenerationLogStatus,
  type ThreadTitleHelperResult,
  type ThreadTitleService,
} from "./backend-registry-types";
import {
  ACP_AVAILABLE_COMMAND_PROBE_COOLDOWN_MS,
  ACP_LISTINGS_ARE_ENRICHED,
  ACP_SESSION_IDLE_CLOSE_CHECK_INTERVAL_MS,
  ActiveTurnControlPreconditionError,
  CODEX_MISSING_THREAD_EVALUATION_DELAY_MS,
  CODEX_RATE_LIMIT_BROADCAST_WINDOW_MS,
  FORGE_TOOL_REQUEST_ID_PREFIX,
  INCOMPLETE_THREAD_LIST_REUSE_WINDOW_MS,
  MAX_ACCEPTED_THREAD_CONTROL_REQUESTS,
  MAX_QUEUE_FLUSH_ATTEMPTS,
  NOTIFICATION_CONTEXT_RECONCILIATION_LIMIT,
  ProjectPausedThreadMessageError,
  TASK_MONITOR_STALE_CHECK_INTERVAL_MS,
  THREAD_LIST_REUSE_WINDOW_MS,
  THREAD_SEARCH_REUSE_WINDOW_MS,
  ThreadAlreadyActiveError,
  archivedThreadMessageRefusal,
  readProviderRuntimeFingerprints,
  shouldBackfillCodexDirectoryRelationships,
  shouldEnrichThreadDirectories,
  threadOrchestrationFailure,
} from "./backend-registry-runtime-helpers";
import { executionModeSettings } from "./execution-mode-settings";
import {
  buildActiveTurnKey,
  buildActiveTurnModeKey,
  buildPendingRequestKey,
  buildTerminalNotificationKey,
  buildTurnStartReservationKey,
  executionModeQueueKey,
  formatQuitThreadKey,
  parseActiveTurnKey,
  parseReservedAcpStartThreadKey,
  parseThreadIdFromThreadTurnKeyBody,
  parseThreadTurnKeyBody,
  taskMonitorThreadKey,
  turnInputAttachmentCacheKey,
} from "./thread-turn-keys";
import {
  GROK_TITLE_HELPER_SESSION_POLICY,
  assistantOutputForTurn,
  attachReviewEntryMetadata,
  buildTitleEligibilityLogDetails,
  buildTurnCausalMessagingContextId,
  buildTurnUserMessageOriginId,
  inferLegacyTaskMonitorMessageOrigins,
  isCausalMessagingContext,
  mergeManagedReviewEntries,
  mergeThreadMessageOrigins,
  queuedMessageTitleHelperCount,
  queuedMessageTitleHelperSubAgentId,
  queuedMessageTitleHelperSubAgentMessage,
  resolveThreadMessageOrigin,
  selfStartedTurnTitle,
  titleHelperSubAgentId,
  titleHelperSubAgentMessage,
  truncateLogValue,
} from "./thread-transcript-helpers";
import {
  readNonEmptyString,
  readOptionalString,
  readRecord,
} from "./backend-registry-notification-values";
import {
  TOKEN_MISER_MANAGED_CAPABILITY_REASON,
  buildCodexConnectionMcpConfig,
  buildCodexConnectionMcpServerName,
  buildCodexParentDynamicToolSpecs,
  buildCodexPdfMcpConfig,
  buildCodexPdfMcpDisabledConfig,
  buildCodexTokenMiserConfig,
  codexMcpIsolationUnavailableError,
  hasManagedTokenMiserCapabilityContract,
  hasTokenMiserActivationTransport,
  hasTokenMiserModelGuidance,
  mergeCodexThreadConfigs,
  schemaRequiredKeys,
  structuredRequiredFieldMatches,
  userActionableMcpConnectionConfigError,
  withoutMcpProjectToolApprovalOffer,
} from "./codex-thread-config";
import {
  appendCodexEnvironmentSetupActivity,
} from "./thread-launchpad-helpers";
import {
  PROVIDER_LIMIT_BACKENDS,
  addTaskMonitorUsageSnapshots,
  anchorReplayTurnUsage,
  buildTaskMonitorUsageLine,
  buildTaskMonitorUsageSnapshot,
  isCodexLimitObservation,
  mergeTurnAnchoredUsageActivities,
} from "./thread-usage-math";
import {
  BACKEND_LABELS,
  EXECUTION_MODE_SUMMARIES,
  acpModelWriteWouldApplyThoughtLevel,
  acpRuntimeModeDefaultsFromCapabilities,
  acpRuntimeStateRequiresFullAccess,
  backendMethodCommands,
  buildCapabilities,
  buildCodexFastModeMismatchNotificationParams,
  buildLaunchpadOptions,
  codexAutoExecutionMode,
  codexRuntimeBuild,
  describeCodexRateLimit,
  getBackendFallbackModels,
  getCodexFastModeMismatchWarning,
  getDefaultModelOption,
  isMeaningfulAccountSummary,
  isUnauthenticatedCodexProvider,
  mergeCommandSummaries,
  mergeMethods,
  readClientAccount,
  readClientRateLimits,
  resolveModelSettingsFromOptions,
  sanitizeAcpRuntimeForExecutionMode,
} from "./thread-model-options";
import {
  buildLocalLinkedDirectory,
  buildWorktreeLinkedDirectory,
  dedupeLinkedDirectoriesByNormalizedIdentity,
  isHandoffDirectory,
  isLikelyToolManagedWorktreePath,
  linkedDirectoryWorktreePath,
  normalizeLinkedDirectoryKind,
  pendingStartedThreadMatchesFilter,
  pendingStartedThreadWorkspaceMatches,
  readCurrentGitBranch,
  resolveBranchDriftExpectedBranch,
  resolveExpectedThreadBranch,
  resolveLinkedDirectoryWorkspaceCwd,
  resolveThreadWorkspaceCwd,
  retainPendingStartedThreadWorkspace,
  toForwardSlashes,
} from "./linked-directory-identity";
import { matchThreadWorkspacePath, threadWorkspacePaths } from "./thread-workspace-paths";
import { scheduledActionIdFromTurnQueueEntry } from "@pwragent/owner-core/scheduled-thread-action-storage";
import {
  QUIET_RESTART_STEER_TEXT,
  QUIET_RESTART_STEER_TIMEOUT_MS,
  RESTART_DISPATCH_FALLBACK_MS,
  THREAD_TURN_QUEUE_ORIGINS,
  buildRestartContinuationText,
  restartQueuedEntry,
  storedRestartQueuedEntry,
} from "./thread-restart-helpers";
import {
  contentHasRenderableImage,
  pendingThreadMessageImageParts,
} from "./thread-orchestration-prompts";
import {
  CODEX_NATIVE_MONITOR_ID_PREFIX,
  codexNativeSubAgentIsTerminal,
  groupCodexNativeSubAgents,
} from "./codex-native-subagents";
import {
  truncateThreadInspectionText,
} from "./thread-inspection-summaries";
import {
} from "./thread-forge-helpers";


const backendRegistryLog = getMainLogger("pwragent:backend-registry");
const backendLifecycleLog = getMainLogger("pwragent:backend-lifecycle");
// Only the local quieting path holds this origin object. Display metadata
// with the same fields cannot opt a steer out of the authority merge.
const QUIET_RESTART_STEER_ORIGIN: AppServerThreadMessageOrigin = Object.freeze({ kind: "pwragent", systemReason: "app-restart" });

function logBackendLifecycleNotification(
  backend: AppServerBackendKind,
  notification: AppServerNotification,
): void {
  if (
    notification.method !== "turn/completed" &&
    notification.method !== "turn/failed" &&
    notification.method !== "turn/cancelled" &&
    notification.method !== "thread/status/changed"
  ) {
    return;
  }

  if (notification.method === "thread/status/changed") {
    backendLifecycleLog.info("backend lifecycle notification", {
      backend,
      method: notification.method,
      status: readStatusType(notification.params.status),
      threadId: notification.params.threadId,
    });
    return;
  }

  if (
    notification.method === "turn/completed" ||
    notification.method === "turn/failed" ||
    notification.method === "turn/cancelled"
  ) {
    backendLifecycleLog.info("backend lifecycle notification", {
      backend,
      method: notification.method,
      status: readTurnStatus(notification.params.turn),
      threadId: notification.params.threadId,
      turnId: notification.params.turnId,
    });
  }
}

let threadListCacheSequence = 0;

class CompactionRecoveryRevoked extends Error {
  constructor(readonly status: "busy" | "discarded" = "discarded") { super("Compaction recovery admission was revoked"); }
}

type IdleSubmission = {
  backend: AppServerBackendKind;
  threadId: string;
  input: AppServerTurnInputItem[];
  origin?: ThreadTurnQueueOrigin;
  messageOrigin?: AppServerThreadMessageOrigin;
};

/** What `submitTurnIfIdle` returns when a wake may join a running turn. */
type JoinedSubmissionResult =
  | ThreadTurnQueueImmediateSubmissionResult
  | Extract<ThreadTurnQueueSubmissionResult, { status: "queued" }>;

export class DesktopBackendRegistry {
  readonly context: RegistryContext;
  /** The PR and forge domain: forge tools, PR bindings and PR attachment. Importers use the facade below. */
  private readonly forgeToolBridge: ForgeToolBridge;
  /** The thread inspection, mutation and maintenance Agent tools. Importers use the facade below. */
  private readonly threadInspectionTools: ThreadInspectionTools;
  /** Thread MCP connections, the MCP gateway's approvals and Codex MCP servers. Importers use the facade below. */
  private readonly threadMcpConnections: ThreadMcpConnections;
  private readonly headlessAutomation: HeadlessAutomationTurns;
  /** Review starts, review sub-agents and managed review output. Importers use the facade below. */
  private readonly managedReviewService: ManagedReviewService;
  private readonly subAgentMonitorService: SubAgentMonitorService;
  private readonly threadUsageLedger: ThreadUsageLedger;
  private readonly threadArchiveCoordinator: ThreadArchiveCoordinator;
  private readonly threadWorkspaceService: ThreadWorkspaceService;
  private readonly threadDirectoryService: ThreadDirectoryService;
  private readonly codexRuntimeSupervisor: CodexRuntimeSupervisor;
  private readonly codexClient: BackendClient;
  private readonly configStore: RegistryDependencies["configStore"];
  private codexBackendSummary?: BackendSummary;
  private codexBackendGeneration = 0;
  /**
   * Bumped whenever the Codex limits are forgotten (an account or plan
   * change, or a refresh of an account without ChatGPT quotas), so discovery
   * keeps the refreshed account rather than its own older account reply.
   * Quota reads need no revision: `planLimits.clear` drops every read
   * requested before it.
   */
  private codexAccountRevision = 0;
  private codexRateLimitBroadcastTimer?: ReturnType<typeof setTimeout>;
  private codexRateLimitLastBroadcastAt?: number;
  /** The last queued rate-limit update; each one applies after its predecessor. */
  private codexRateLimitsUpdateTail: Promise<unknown> = Promise.resolve();
  private pendingCodexRateLimitBroadcast?: AgentEvent;
  /**
   * Every provider's account plan limits, which only move forward. The Codex
   * entry's account is the key captured with each reading, so later Settings
   * edits cannot relabel it. Claude and the ACP agents write through it too.
   */
  private readonly planLimits: PlanLimitStore;
  /** The cached Codex summary joined with the store's limits, rebuilt only when either changes. */
  private codexSummaryView?: {
    base: BackendSummary;
    rateLimits: BackendRateLimitSummary[] | undefined;
    summary: BackendSummary;
  };
  private codexQuotaRefresh?: Promise<void>;
  private codexQuotaRefreshAt?: number;
  private providerRuntimeFingerprints?: Readonly<Record<ProviderId, string>>;
  private providerRuntimeInvalidationPromise?: Promise<void>;
  private readonly correspondenceStore: ThreadCorrespondenceStore;
  private readonly pendingEnvironmentLaunchStore: PendingEnvironmentLaunchStore;
  private readonly overlayStore: BackendRegistryOverlayStoreLike;
  private readonly gitDirectoryService: GitDirectoryService;
  private readonly gitWorkingStateService: GitWorkingStateService;
  private readonly workingStateByWorktree = new Map<
    string,
    WorktreeGitWorkingStateCacheEntry
  >();
  private workingStateCacheLoad: Promise<void> | undefined;
  private readonly worktreeArchiveService: WorktreeArchiveService;
  private readonly worktreeRecoveryService: WorktreeRecoveryService;
  private readonly acpBackend: AcpBackendAdapter;
  private readonly acpSessionRuntimeOptions: AcpSessionRuntimeOptions;
  private readonly threadModelSettings: ThreadModelSettings;
  private readonly claudeBackend: ClaudeBackend;
  private readonly claudeAgentToolMcpServer?: AgentToolMcpServerLike;
  private closed = false;
  private shutdownRequested = false;
  private closeOperation?: Promise<void>;
  // Resolves a managed-worktree ACP cwd to its repository checkout so ACP
  // (e.g. Grok) worktree threads group under the same directory row as their
  // repo, exactly like Codex threads do. Codex backends carry a repo-rooted
  // linked directory from their own enricher; ACP sessions only know their cwd,
  // so without this every ACP worktree session lands in its own folder. Pure
  // filesystem — follows the worktree's `.git` link and NEVER spawns git. The
  // repo↔worktree mapping is immutable, so the result is cached durably on the
  // thread overlay (`acpWorktreeDirectory`) and this resolver only runs on the
  // first sighting of a given cwd. Injectable for deterministic tests.
  private readonly acpWorktreeRepositoryResolver: (
    cwd: string,
    options?: { fresh?: boolean },
  ) => Promise<LinkedDirectorySummary | undefined>;
  // Launchpad drafts have no ACP session to ask for `availableCommands`, so the
  // repo's last-observed list is cached here and replayed for them. See
  // `resolveAcpAvailableCommands` for the read path and
  // `rememberAcpAvailableCommands` for the write-through.
  private readonly acpAvailableCommandsStore?: AcpAvailableCommandsStorage;
  private readonly acpAvailableCommandProbeBudgetMs: number;
  private readonly acpAvailableCommandProbes = new Map<
    string,
    Promise<AppServerAvailableCommandSummary[]>
  >();
  private readonly acpAvailableCommandProbeCooldowns = new Map<string, number>();
  private readonly acpAvailableCommandWaiters = new Map<
    string,
    Set<(commands: AppServerAvailableCommandSummary[]) => void>
  >();
  private readonly messagingStore?: MessagingArchiveCleanupStore | null;
  private readonly createScratchProjectDirectory: () => Promise<string>;
  private readonly resolveAcpHelperWorkspace: () => Promise<string>;
  private createScheduledThreadActionFn?: (
    request: CreateScheduledThreadActionRequest,
    options: { id: string },
  ) => Promise<ScheduledThreadActionMutationResponse>;
  private readonly threadTitleGenerationService?: ThreadTitleService;
  private readonly modelCatalog: BackendModelCatalog;
  private readonly codexEnvironmentCommandEnv?: NodeJS.ProcessEnv;
  private readonly threadListCacheOwnerId = `backend-thread-list-cache-${++threadListCacheSequence}`;
  private readonly threadListCache = new Map<string, ThreadListCacheState>();
  private createdThreadDirectoryVisibility = new Map<
    string,
    CreatedThreadDirectoryVisibility
  >();
  private navigationDirectoriesByKey = new Map<
    string,
    NavigationDirectorySummary
  >();
  private createdThreadVisibilityPinnedRanks: string[] = [];
  private readonly createdThreadVisibilityLock = new PerKeyAsyncLock();
  private readonly projectHeldWakeupStore?: ProjectHeldWakeupStoreLike;
  /** Project-held entries with a durable copy, by queue entry id, as stored. */
  private readonly durableProjectHeldWakeups = new Map<string, StoredProjectHeldWakeup>();
  private readonly restartContinuationStore?: RestartContinuationStoreLike;
  /** Restart continuations and saved queued messages with a durable row, by queue entry id. */
  private readonly durableRestartContinuations = new Map<string, StoredRestartContinuation>();
  private readonly quietRestartCheckpoint = new Map<string, StoredRestartContinuation>();
  private appRestartVerification?: StoredRestartContinuation;
  /** See `restart-continuation-gate.ts`. */
  private restartGate: RestartGateState = OPEN_RESTART_GATE;
  private beforeQuietRestartGate?: RestartGateState;
  private readonly restartGateTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly restartGateListeners = new Set<(closed: boolean) => void>();
  private readonly restartGateStatusListeners = new Set<(status: RestartGateStatus) => void>();
  private restartDispatchStarted = false;
  private readonly restartDispatchPlanOptions: Omit<RestartDispatchPlanOptions, "now">;
  private readonly pendingStartedThreads = new Map<string, AppServerThreadSummary>();
  private readonly acceptedHandoffTaskRequests = new Map<
    string,
    AcceptedThreadControlRequest
  >();
  private readonly acceptedDynamicToolCalls = new Map<
    string,
    AcceptedDynamicToolCall
  >();
  private readonly codexProtocolCaptureSession?: CodexProtocolCaptureSession;
  private readonly captureStores: ProtocolCaptureStore[];
  readonly navigationDirectoryScope = new NavigationDirectoryScope();
  private readonly eventListeners = new Set<
    (event: AgentEvent) => void | Promise<void>
  >();
  private latestCodexConfigWarning?: AgentEvent;
  /** Error-boundary ownership, indexed by raw thread/turn identity for token delivery. */
  private readonly streamNoticeOwners = new Map<
    string,
    Map<string, NonNullable<AgentEvent["errorNoticeContext"]>>
  >();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly fileChangeApprovalContexts = new Map<
    string,
    PendingRequestApprovalContext
  >();
  private readonly turnInputAttachments = new Map<
    string,
    { input: AppServerTurnInputItem[] }
  >();
  private readonly pendingThreadMessageContexts = new Map<
    string,
    PendingThreadMessageContext
  >();
  private codexMessageContextTurnSequence = 0;
  private readonly codexMessageContextTurnObservations = new Map<string, Map<string, number>>();
  private readonly acceptedThreadControlRequests = new Map<
    string,
    AcceptedThreadControlRequest
  >();
  private readonly acceptedActiveTurnControlRequests = new Map<
    string,
    AcceptedActiveTurnControlRequest
  >();
  /**
   * Threads Codex answered `thread not found` for during this session. An id
   * stays here once it lands, whatever the audit decides, so a later
   * `thread/list` cannot reschedule the retries this set exists to suppress.
   * Because the scheduler skips these threads, nothing it does can clear one;
   * only an operator-driven workspace handoff, which bypasses the scheduler,
   * can prove the thread came back. Otherwise the suppression lasts the
   * session, and a restart re-audits from scratch.
   */
  private readonly missingCodexThreadIds = new Set<string>();
  /** The subset still awaiting an archive-or-keep outcome. */
  private readonly unresolvedMissingCodexThreadIds = new Set<string>();
  private missingCodexThreadEvaluationTimer?: ReturnType<typeof setTimeout>;
  private missingCodexThreadEvaluation?: Promise<void>;
  /** Visible Codex thread count from the full list, for the operator notice. */
  private codexVisibleThreadCount = 0;
  private readonly observedCodexSettingsByThread = new Map<string, ObservedCodexSettings>();
  /**
   * Codex reverts in flight, and whether Codex has already announced the
   * revert (its thread/reverted, normalized to thread/rewound). The registry
   * announces only a revert Codex did not, so windows reload once.
   */
  /**
   * Codex threads this registry is reverting, and whether Codex has reported
   * the revert. The registry announces each revert itself.
   */
  private readonly codexRevertsInFlight = new Map<string, { reported: boolean }>();
  private readonly reservedAcpStartThreadKeys = new Set<string>();
  private readonly threadLifecycleLocks = new PerKeyAsyncLock();
  private readonly threadAttachmentAdmissionLocks = new PerKeyAsyncLock();
  private readonly threadStarts = new ThreadTurnStartLifecycle({
    assertAvailable: ({ backend, threadId }) => this.assertThreadNotHandingOff(backend, threadId),
    withMutation: (identity, work) => this.withThreadLifecycleMutation(identity, work),
    assertUnlocked: ({ backend, threadId }) => this.assertThreadNotLocked(backend, threadId),
    wake: (identity) => this.threadArchiveCoordinator.ensureCheckoutAwake(identity),
  });
  private readonly transcriptRepairs = new Map<string, Promise<void>>();
  private readonly pendingTranscriptRepairReplays = new Map<string, AppServerThreadReplay>();
  private readonly taskMonitorWatchdogTimer?: NodeJS.Timeout;
  private readonly runtimeInstanceId: string;
  private readonly registrySessionId: string;
  private readonly resolveLiveProfileRuntimeInstanceIdsFn: () => string[];
  private readonly subAgentStartupReconciliation: Promise<void>;
  private readonly usageTurnStartupRepair: Promise<void>;
  private readonly runningTurnShutdownStopTimeoutMs: number;
  private runningTurnsShutdownStop?: Promise<void>;
  private runningTurnsShutdownStopSettled = false;
  /** Set once a quit starts stopping turns; the queue starts nothing after. */
  private stoppingRunningTurnsForShutdown = false;
  private readonly activeTurnBranchProbeAbort = new AbortController();
  /** Terminal events still in the delivery pipeline, including before quit. */
  private readonly pendingTerminalEmits = new Set<Promise<void>>();
  /**
   * What this process knows about each thread it has seen, keyed by thread
   * identity rather than by the query that revealed it.
   *
   * Distinct from `threadListCache`, which answers "which threads match this
   * query" and is correctly discarded by any mutation. This answers "what is
   * this thread called", where discarding is never correct: the previous answer
   * remains the best one until a newer observation replaces it. Reads are
   * synchronous and cannot start provider work, so a 500ms UI poll can use one.
   */
  private readonly threadInfoStore = new ThreadInfoStore();
  private readonly providerThreadSnapshotStore?: ProviderThreadSnapshotStorage;
  private readonly retainedOwnerThreadStorage?: RetainedOwnerThreadStorage;
  private durableStartupThreadHydrationAttempted = false;
  private startupProviderRefreshAttempted = false;
  private startupCodexRefreshFailed = false;
  private startupProviderRefreshPromise?: Promise<void>;
  private startupProviderRefreshStatus?: Readonly<StartupProviderRefreshStatus>;
  /**
   * Listings that stand in an empty Codex inventory for a failed provider read.
   * Navigation reads this per listing: the startup refresh status records one
   * attempt, so a recovered Codex would stay incomplete and a later failure
   * would pass as complete. Claude and ACP rows come from PwrAgent's own
   * stores, and their read errors reject the listing instead.
   */
  private readonly incompleteThreadLists = new WeakSet<readonly AppServerThreadSummary[]>();
  /**
   * In-flight terminal-notification label reconciliations, keyed by thread. A
   * burst of turn completions on threads this process never observed must cost
   * one provider walk per thread, not one per notification.
   */
  private readonly notificationContextReconciliations = new Map<
    string,
    Promise<void>
  >();
  /**
   * Live `thread/name/updated` observations are newer than the provider's
   * thread list during an active turn. Reconcile list rows through this map so
   * federation snapshots and remote search do not regress to a placeholder
   * after the local renderer has already received the generated name.
   *
   * The provenance travels with the name. Re-stating it as `explicit` on the
   * way out would undo what the rename recorded, and every reader here writes
   * at a newer sequence than the rename did — so the guess, not the rename,
   * would be what the store keeps.
   */
  private readonly observedThreadNames = new Map<
    string,
    { title: string; titleSource: AppServerRenamedTitleSource }
  >();
  private hasLoggedNotificationsEnabledError = false;
  private readonly threadTurnQueue: ThreadTurnQueue;
  private readonly queuedMessageTitler: QueuedMessageTitler;
  private automationInspectionHandler?: AutomationInspectionHandler;
  private appManagementHandler?: PwrAgentAppManagementHandler;
  private messagingWorkingUpdatesSettings?: Pick<DesktopSettingsService, "readMessagingSettings" | "setDevelopmentWorkingUpdatesDefault">;
  private starMapHandler?: PwrAgentStarMapHandler;
  private threadTodoHandler?: PwrAgentThreadTodoHandler;
  private openAIDecisionsHandler?: PwrAgentOpenAIDecisionsHandler;
  private researchHandler?: ResearchAgentHandler;
  private checkoutHandler?: CheckoutToolHandler;
  private prepareCheckoutWakeup?: (entry: ThreadTurnQueueEntry, dependencyId: string) => Promise<AppServerTurnInputItem[]>;
  private researchEnabled: () => boolean = () => false;
  private researchWorkerCheck?: (thread: { backend: AppServerBackendKind; threadId: string }) => boolean;
  private agentThreadActions?: AgentThreadActions;
  private messagingAgentToolService?: MessagingAgentToolService;
  private readonly changingCodexAgentThreadIds = new Set<string>();
  private readonly inFlightCodexAttachments = new Map<string, number>();
  private readonly messagingHandler: PwrAgentMessagingHandler =
    async (request) => {
      const pdfResponse = await handlePwrAgentPdfToolRequest({
        request,
        store: this.pdfAttachmentStore,
      });
      if (pdfResponse) {
        return pdfResponse;
      }
      if (request.context.backend === "codex" && ["attach_thread_here", "attach_thread_to_surface", "list_messaging_surfaces"].includes(request.operation)) {
        const threadId = request.context.threadId;
        if (this.changingCodexAgentThreadIds.has(threadId)) {
          return {
            ok: false,
            error: {
              code: "forbidden",
              message: "Agent thread status is changing. Retry after the change completes.",
            },
          };
        }
        this.inFlightCodexAttachments.set(
          threadId,
          (this.inFlightCodexAttachments.get(threadId) ?? 0) + 1,
        );
        try {
          const overlay = await this.overlayStore.getThreadOverlayState(request.context);
          // Handoff threads retain their existing attachment authority. Neither
          // a discovered tool definition nor an old binding grants authority.
          if (!overlay?.agent && !overlay?.handoffOrigin) {
            return {
              ok: false,
              error: {
                code: "forbidden",
                message: "Mark this thread as an Agent before managing messaging attachments.",
              },
            };
          }
          return await this.dispatchMessagingRequest(request);
        } finally {
          const remaining = this.inFlightCodexAttachments.get(threadId)! - 1;
          if (remaining) {
            this.inFlightCodexAttachments.set(threadId, remaining);
          } else {
            this.inFlightCodexAttachments.delete(threadId);
            for (const resolve of this.codexAttachmentDrainWaiters.get(threadId) ?? []) resolve();
            this.codexAttachmentDrainWaiters.delete(threadId);
            this.scheduleQueuedAgentChange(threadId);
          }
        }
      }
      return await this.dispatchMessagingRequest(request);
    };

  private async dispatchMessagingRequest(
    request: Parameters<PwrAgentMessagingHandler>[0],
  ): Promise<Awaited<ReturnType<PwrAgentMessagingHandler>>> {
    if (!this.messagingAgentToolService) {
      return {
        ok: false,
        error: {
          code: "unsupported_operation",
          message: "PwrAgent messaging context tools are not available.",
        },
      };
    }
    const origin = await this.readTurnCausalMessagingOrigin(request.context);
    return await this.messagingAgentToolService.handlePwrAgentMessagingRequest({
      ...request,
      context: { ...request.context,
        ...(origin?.causalMessagingSource ? { causalMessagingSource: origin.causalMessagingSource } : {}),
        ...(origin?.causalMessagingAmbiguous ? { causalMessagingAmbiguous: true } : {}),
        ...(["list_messaging_attachments", "export_messaging_attachment"].includes(request.operation)
          && (origin?.kind === "messaging" || origin?.messaging) ? { messagingTurn: true } : {}),
      },
    });
  }

  /** Exact, indexed origin lookup. Never hydrate a transcript or traverse ancestry. */
  async readCausalMessagingContext(context: { backend: AppServerBackendKind; threadId: string; turnId?: string }): Promise<
    Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">
  > {
    const origin = await this.readTurnCausalMessagingOrigin(context);
    return { ...(origin?.causalMessagingSource ? { causalMessagingSource: origin.causalMessagingSource } : {}),
      ...(origin?.causalMessagingAmbiguous ? { causalMessagingAmbiguous: true } : {}) };
  }

  /**
   * A causal steer writes the turn's routing record under its own key.
   * Until one does, the turn's first prompt origin is the record. While the
   * turn is starting, that origin is in memory before its row is written.
   */
  private async readTurnCausalMessagingOrigin(
    context: { backend: AppServerBackendKind; threadId: string; turnId?: string },
    allowUnbound = true,
  ): Promise<AppServerThreadMessageOrigin | undefined> {
    if (!context.turnId) return undefined;
    const starting = this.findStartingTurnOrigin(context);
    const causalId = buildTurnCausalMessagingContextId(context.turnId);
    const promptId = buildTurnUserMessageOriginId(context.turnId);
    const origins = this.overlayStore.readThreadMessageOrigins
      ? await this.overlayStore.readThreadMessageOrigins({ ...context, messageIds: [causalId, promptId] })
      : {};
    // Before the start call returns, the turn id is unknown. A thread starts
    // one turn at a time, so an unbound origin belongs to the turn calling.
    return origins[causalId]
      ?? (starting?.turnId ? starting.origin : undefined)
      ?? origins[promptId]
      ?? (allowUnbound ? starting?.origin : undefined);
  }

  /** The origin bound to this turn, else the thread's origin still awaiting its turn id. */
  private findStartingTurnOrigin(context: { backend: AppServerBackendKind; threadId: string; turnId?: string }): StartingTurnOrigin | undefined {
    let unbound: StartingTurnOrigin | undefined;
    for (const entry of this.context.turnState.startingOrigins()) {
      if (entry.backend !== context.backend || entry.threadId !== context.threadId) continue;
      if (entry.turnId === undefined) unbound = entry;
      else if (entry.turnId === context.turnId) return entry;
    }
    return unbound;
  }

  private readonly currentTurnInputSource: CurrentTurnInputSourceHandler = (context) => {
    if (!context.turnId) return "unknown";
    const turn = { ...context, turnId: context.turnId };
    return this.context.turnState.readTurnInputSource(turn)
      ?? this.findStartingTurnOrigin(turn)?.turnInputSource
      ?? "unknown";
  };

  /**
   * Call before the provider starts the turn. Every path must end in
   * `persistStartingTurnOrigin` or `dropStartingTurnOrigin`.
   */
  private beginStartingTurnOrigin(params: {
    backend: AppServerBackendKind;
    threadId: string;
    origin?: AppServerThreadMessageOrigin;
    turnInputSource?: TurnInputSource;
  }): StartingTurnOrigin | undefined {
    if (!params.origin && params.turnInputSource === undefined) return undefined;
    const entry: StartingTurnOrigin = {
      backend: params.backend, threadId: params.threadId, origin: params.origin,
      turnInputSource: resolveTurnInputSource({ turnInputSource: params.turnInputSource, messageOrigin: params.origin }),
    };
    this.context.turnState.addStartingOrigin(entry);
    return entry;
  }

  /** Bind as soon as the start call returns, so the origin matches this turn only. */
  private bindStartingTurnOrigin(
    entry: StartingTurnOrigin | undefined,
    turn: { threadId: string; turnId: string },
    terminalObserved = false,
  ): void {
    if (!entry) return;
    this.context.turnState.bindStartingOrigin(entry, turn);
    const identity = { ...turn, backend: entry.backend };
    if (entry.turnInputSource !== undefined && !terminalObserved
      && (entry.backend === "codex" || this.context.turnState.hasRegisteredTurn(identity))) {
      this.context.turnState.rememberTurnInputSource(identity, entry.turnInputSource);
    }
  }

  private dropStartingTurnOrigin(entry: StartingTurnOrigin | undefined): void {
    if (entry) this.context.turnState.removeStartingOrigin(entry);
  }

  /** Writes the bound origin as the turn's `user:<turnId>` row, then forgets it. */
  private async persistStartingTurnOrigin(entry: StartingTurnOrigin | undefined): Promise<void> {
    const bound = entry ? this.context.turnState.startingOrigin(entry) : undefined;
    if (!bound?.turnId || !bound.origin) {
      this.dropStartingTurnOrigin(entry);
      return;
    }
    try {
      await this.persistThreadMessageOrigin({
        backend: bound.backend,
        threadId: bound.threadId,
        messageId: buildTurnUserMessageOriginId(bound.turnId),
        origin: bound.origin,
      });
    } finally {
      this.dropStartingTurnOrigin(entry);
    }
  }

  // PR and forge members the registry's importers use. ForgeToolBridge owns
  // the state; each member delegates to it. The app-server service needs the
  // registry before it can supply these bindings, so it calls the setters late.
  setForgeReadHandlers(local: ForgeReadHandler, routed: ForgeReadHandler): void {
    this.forgeToolBridge.setForgeReadHandlers(local, routed);
  }

  setForgePrToolHandler(handler: ForgePrToolHandler, preflight?: ForgePrToolPreflight): void {
    this.forgeToolBridge.setForgePrToolHandler(handler, preflight);
  }

  setForgeToolPolicyResolver(resolve: () => ForgeAgentToolPolicy): void {
    this.forgeToolBridge.setForgeToolPolicyResolver(resolve);
  }

  setForgeToolRuleWriter(write: ForgeToolRuleWriter): void {
    this.forgeToolBridge.setForgeToolRuleWriter(write);
  }

  setForgeProjectLabelResolver(resolve: (repository: string) => Promise<string | undefined>): void {
    this.forgeToolBridge.setForgeProjectLabelResolver(resolve);
  }

  readForgeForPeer(request: ForgeReadRequest, signal?: AbortSignal): Promise<unknown> {
    return this.forgeToolBridge.readForgeForPeer(request, signal);
  }

  setThreadPullRequestStatusToolHandler(handler: ThreadPullRequestStatusToolHandler | null | undefined): void {
    this.forgeToolBridge.setThreadPullRequestStatusToolHandler(handler);
  }

  setThreadPullRequestCanonicalizer(canonicalizer: ThreadPullRequestCanonicalizer | null | undefined): void {
    this.forgeToolBridge.setThreadPullRequestCanonicalizer(canonicalizer);
  }

  setPullRequestReferenceResolver(resolver: PullRequestReferenceResolver | null | undefined): void {
    this.forgeToolBridge.setPullRequestReferenceResolver(resolver);
  }

  setThreadProjectRepositoryResolver(
    resolver: (backend: AppServerBackendKind, threadId: string) => Promise<string | undefined>,
  ): void {
    this.forgeToolBridge.setThreadProjectRepositoryResolver(resolver);
  }

  setThreadPrimaryGitRepositoryReader(
    reader: ((backend: AppServerBackendKind, threadId: string) => string | undefined) | undefined,
  ): void {
    this.forgeToolBridge.setThreadPrimaryGitRepositoryReader(reader);
  }

  setLocalPullRequestAuthorityResolver(resolver: LocalPullRequestAuthorityResolver | null | undefined): void {
    this.forgeToolBridge.setLocalPullRequestAuthorityResolver(resolver);
  }

  isPullRequestLocallyMonitored(prKey: string): boolean {
    return this.forgeToolBridge.isPullRequestLocallyMonitored(prKey);
  }

  setThreadPullRequestWatchToolHandler(handler: ThreadPullRequestWatchToolHandler | null | undefined): void {
    this.forgeToolBridge.setThreadPullRequestWatchToolHandler(handler);
  }

  setThreadPullRequestDetachHandler(handler: ThreadPullRequestDetachHandler | null | undefined): void {
    this.forgeToolBridge.setThreadPullRequestDetachHandler(handler);
  }

  setThreadPrWatchesPeerHandler(handler: ThreadPrWatchesPeerHandler | null | undefined): void {
    this.forgeToolBridge.setThreadPrWatchesPeerHandler(handler);
  }

  manageThreadPrWatchesForPeer(
    request: import("@pwragent/shared/contracts/thread-pr-watches").FederationThreadPrWatchesRequestV1,
  ): Promise<import("@pwragent/shared/contracts/thread-pr-watches").ThreadPrWatchesResponse> {
    return this.forgeToolBridge.manageThreadPrWatchesForPeer(request);
  }

  setProjectForgeAutomationHandler(handler: ProjectForgeAutomationHandler | null | undefined): void {
    this.forgeToolBridge.setProjectForgeAutomationHandler(handler);
  }

  ownedProjectForgeAutomation(): ProjectForgeAutomationHandler {
    return this.forgeToolBridge.ownedProjectForgeAutomation();
  }

  setThreadPullRequestRefreshHandler(handler: ThreadPullRequestRefreshHandler | null | undefined): void {
    this.forgeToolBridge.setThreadPullRequestRefreshHandler(handler);
  }

  refreshOwnedThreadPullRequests(
    request: RefreshOwnedThreadPullRequestsRequest,
  ): Promise<RefreshThreadPullRequestsResponse> {
    return this.forgeToolBridge.refreshOwnedThreadPullRequests(request);
  }

  detachThreadPullRequest(params: DetachThreadPullRequestRequest): Promise<DetachThreadPullRequestResponse> {
    return this.forgeToolBridge.detachThreadPullRequest(params);
  }

  canonicalizeNavigationThreadPullRequests(
    threads: NavigationSnapshot["threads"],
    demand?: PrMetadataDemand,
    verifyAttachments = true,
  ): Promise<NavigationSnapshot["threads"]> {
    return this.forgeToolBridge.canonicalizeNavigationThreadPullRequests(threads, demand, verifyAttachments);
  }

  canonicalizeNavigationPullRequests(prs: NonNullable<NavigationSnapshot["threads"][number]["prs"]>, demand?: PrMetadataDemand): Promise<typeof prs> {
    return this.forgeToolBridge.canonicalizeNavigationPullRequests(prs, demand);
  }

  withNavigationPrimaryGitRepositories(threads: NavigationSnapshot["threads"]): NavigationSnapshot["threads"] {
    return this.forgeToolBridge.withNavigationPrimaryGitRepositories(threads);
  }

  // Thread inspection members the registry's importers use. ThreadInspectionTools
  // owns the state; each member delegates to it.
  mutateThreadParentV1(
    request: MutateThreadParentV1Request,
  ): Promise<PwrAgentThreadInspectionResponse> {
    return this.threadInspectionTools.mutateThreadParentV1(request);
  }

  private readonly agentMemory = new AgentMemoryStore(undefined, () => this.assertThreadOwnership());

  private readonly threadInspectionHandler: PwrAgentThreadInspectionHandler = async (request) => {
    if (request.operation !== "agent_memory") {
      return await this.threadInspectionTools.handleThreadInspectionRequest(request);
    }
    try {
      return { ok: true, data: { memory: await this.accessAgentMemory(request.context, request.args) } };
    } catch (error) {
      if (error instanceof AgentMemoryError) {
        return { ok: false, error: { code: error.code === "conflict" ? "invalid_arguments" : error.code, message: error.message } };
      }
      return { ok: false, error: { code: "internal_error", message: "Agent memory could not be accessed." } };
    }
  };
  private federatedThreadInspectionHandler:
    | PwrAgentFederatedThreadInspectionHandler
    | undefined;
  private readonly threadOrchestrationHandler: PwrAgentThreadOrchestrationHandler =
    async (request) => await this.handleThreadOrchestrationRequest(request);
  private federationHandler: PwrAgentFederationHandler | undefined;
  private agentCreatedThreadObserver: AgentCreatedThreadObserver | undefined;
  private starMapIntakeFederationHandlerFactory:
    | ((attachments: AppServerTurnInputItem[]) => PwrAgentFederationHandler)
    | undefined;
  private federatedThreadMessageHandler:
    | PwrAgentFederatedThreadMessageHandler
    | undefined;
  private localFederationInstanceId: (() => string | undefined) | undefined;
  private federatedThreadControlHandler:
    | PwrAgentFederatedThreadControlHandler
    | undefined;
  private threadDependencyToolHandler:
    | ((args: import("@pwragent/shared/contracts/thread-dependencies").ManageThreadDependenciesRequest, provenance?: Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">, actor?: string) => Promise<PwrAgentThreadInspectionResponse>)
    | undefined;
  private agentFollowUpToolHandler: import("./backend-registry-handlers").AgentFollowUpToolHandler | undefined;
  private directoryGitStatusWriter: DirectoryGitStatusWriter | undefined;
  private readonly pendingDirectoryGitStatusKeys = new Set<string>();
  private readonly pendingThreadGitWorkingStateByPath = new Map<
    string,
    Promise<void>
  >();
  private readonly focusedThreadGitWorkingStateRefreshByPath = new Map<
    string,
    {
      userAction?: boolean;
      acceptedPushedCommitShas: string[] | undefined;
      rerunRequested: boolean;
      running: boolean;
    }
  >();
  private readonly focusedThreadGitWorkingStateRefreshes = new Set<Promise<void>>();
  private threadGitWorkingStateRefreshRound: Promise<void> | undefined;
  private threadPrAutoDispatchHandler: ThreadPrAutoDispatchHandler | undefined;
  private threadGitWorkingStateRefreshHandler:
    | ThreadGitWorkingStateRefreshHandler
    | undefined;
  private ownerThreadSearchService: ThreadSearchService | undefined;
  /**
   * In-memory queue of pending permission-mode changes, keyed by
   * threadId. Populated when a user toggles execution mode while a turn
   * is active; flushed at the resume boundary (turn-end, or just before
   * the next turn-start). Not persisted across app restart by design —
   * the corresponding audit-log entries on overlay state carry the
   * historical record.
   */
  private readonly queuedExecutionModes = new Map<
    string,
    {
      backend: AppServerBackendKind;
      mode: ThreadExecutionMode;
      queuedAt: number;
      queueId: string;
      flushAttempts: number;
    }
  >();
  private readonly queuedExecutionModeFlushes = new Map<string, Promise<void>>();
  private readonly executionModeSelectionLocks = new PerKeyAsyncLock();
  private readonly acpSessionPromptLocks = new PerKeyAsyncLock();
  private readonly activeTurnControlLocks = new PerKeyAsyncLock();
  private readonly turnCausalContextLocks = new PerKeyAsyncLock();
  /**
   * Gate for the Codex `listThreads` probe. Returns `true` while the
   * first-run wizard is still asking the operator which Codex profile
   * model to use; in that window we must not slurp Codex threads under
   * an arbitrary identity. Tests inject a fixed value; production wires
   * it to `DesktopSettingsService.isCodexBootstrapDeferred`, which is
   * itself dormant (always returns `false`) until the wizard PR flips
   * `ONBOARDING_CODEX_GATE_ENABLED`.
   */
  private readonly isCodexBootstrapDeferredFn: () => boolean;
  private readonly resolveCodexDefaultModeRequestUserInputFn: () => boolean;
  private readonly resolveCodexToolDiscoveryFn: () => boolean;
  private readonly resolveDefaultPrAutoDispatchEnabledFn: () => boolean;
  private readonly resolveProviderModelDefaultsFn: () => Record<
    string,
    DesktopProviderModelDefaults
  >;
  private readonly resolveHelperModelSettingsFn: () => DesktopHelperModelSettings;
  /** `[[models.task_monitor_models]]`, keyed by the parent thread's provider. */
  private readonly resolveTaskMonitorModelsFn: () => Record<string, DesktopTaskMonitorModelChoice>;
  /** `general.pass_setup_variables_to_agents`, read at each agent start. */
  private readonly resolvePassSetupVariablesToAgentsFn: () => boolean;
  private readonly resolveUsageAccountGroupsFn: () => Record<string, string>;
  private readonly resolveProviderThreadModelMigrationsFn: () => Record<
    string,
    DesktopProviderThreadModelMigration
  >;
  private readonly resolveCodexFastAllowedFn: () => boolean;
  private readonly resolveCodexLocalModelIdsFn: () => string[];
  private readonly resolveCodexModelProvidersFn: () => CodexModelProviderSettings[];
  private readonly resolveCodexModelProviderKeysFn: () => Promise<Record<string, string>>;
  private readonly codexModelProviderCatalog: CodexModelProviderCatalog;
  private readonly codexProviderCatalogRetry: CodexProviderCatalogRetry;
  /**
   * Bumped on every explicit save or change from disk to the Codex model
   * provider list. Reads from an earlier revision cannot publish over it.
   */
  private codexModelProviderRevision = 0;
  /** Orders catalog refreshes that share one saved provider list. */
  private codexModelProviderRefreshRevision = 0;
  /** Publications of provider list changes, in the order they were saved. */
  private codexModelProviderPublication: Promise<void> = Promise.resolve();
  private readonly resolvePdfAnalysisEnabledFn: () => boolean;
  private readonly resolveTokenMiserEnabledFn: () => boolean;
  private readonly acpSessionIdleCloseMs: number;
  private acpIdleSessionTimer?: NodeJS.Timeout;
  private acpIdleSessionSweep?: Promise<void>;
  private readonly resolveTokenMiserDefaultEnabledFn: () => boolean;
  private readonly resolveTokenMiserPollingReviewsEnabledFn: () => boolean;
  private readonly resolveManagedTokenMiserActivationRequiredFn: () => boolean;
  private readonly resolveCodexDiscoveryPendingFn: () => boolean;
  private readonly resolveSpendAlertPolicyFn: () => DesktopSpendAlertPolicy;
  private readonly resolveToolOutputAlertPolicyFn: () => DesktopToolOutputAlertPolicy;
  private spendAlertPolicy = DESKTOP_SPEND_ALERT_POLICY_DEFAULT;
  private toolOutputAlertPolicy = DESKTOP_TOOL_OUTPUT_ALERT_POLICY_DEFAULT;
  private readonly localFilePrivateStorageRoots: readonly string[];
  private readonly pdfAttachmentStore = new PdfAttachmentStore();
  private readonly pdfToolMcpServer?: AgentToolMcpServerLike;
  private readonly tokenMiserStore?: TokenMiserStore;
  private readonly tokenMiserDiagnostics?: TokenMiserDiagnostics;
  private readonly tokenMiserService?: TokenMiserService;
  private readonly tokenMiserHookBridge?: TokenMiserHookBridge;
  private tokenMiserCodeModeReducerDescriptorPath?: string;
  private readonly tokenMiserServerCapabilities = new WeakMap<
    BackendClient,
    Promise<CodexServerCapabilities | undefined>
  >();
  private readonly tokenMiserServerCapabilitiesForTurn =
    new AsyncLocalStorage<
      WeakMap<BackendClient, Promise<CodexServerCapabilities | undefined>>
    >();
  private tokenMiserReducerCapabilityState?: "supported" | "unsupported";
  private tokenMiserCodeModeGroupingVersion?: number;
  private tokenMiserPostToolUseExactOutputVersion?: number;
  private tokenMiserRuntimePreparationFailure?: string;
  private readonly tokenMiserPluginManager?: TokenMiserPluginManager;
  private tokenMiserStateDir?: string;
  private readonly resolveTokenMiserCodexRuntimeFn?: () => Promise<{
    codexCommand: string;
    codexEnv: NodeJS.ProcessEnv;
  }>;
  /**
   * The Codex executable a launch would use right now — the same resolution
   * the stdio transport performs, so the summary describes the runtime that
   * actually answers, not one a later discovery pass might select.
   *
   * It is the only reliable source for a managed build: `resolveCodexCommand`
   * returns the PwrAgent-managed runtime before it consults discovery, so a
   * profile running one can reach the App Server without ever recording a
   * provider observation, leaving the durable projection empty.
   */
  private readonly resolveCodexRuntimeCommandFn?: () => Promise<{
    command: string;
    version?: string;
  }>;
  private readonly mcpConnectionService?: BackendRegistryMcpConnectionService;
  private readonly mcpGatewayTools?: McpGatewayToolService;
  /**
   * Reports whether the registry is running inside the throwaway
   * bootstrap profile (`.bootstrap/`). When `true`, `listThreads`
   * hard-fails to an empty result regardless of any other gate —
   * the bootstrap profile's `models.codex.profile` is unset and
   * would otherwise resolve to the operator's real Codex install,
   * leaking their real thread list into the to-be-discarded
   * bootstrap window. Tests inject a fixed value; production wires
   * it to `state/app-state.getAppStateMode()`.
   */
  private readonly isBootstrapModeFn: () => boolean;
  private readonly ownerAdmission?: ThreadOwnerAdmission;
  private readonly turnEventObservers: TurnEventObservers;
  constructor(
    dependencies: RegistryDependencies,
    connect: (ports: ReturnType<DesktopBackendRegistry["constructionPorts"]>) => void,
  ) {
    this.context = dependencies.context;
    this.turnEventObservers = dependencies.turnEventObservers;
    this.ownerAdmission = dependencies.ownerAdmission;
    this.configStore = dependencies.configStore;
    this.runtimeInstanceId = dependencies.runtimeInstanceId;
    this.projectHeldWakeupStore = dependencies.projectHeldWakeupStore;
    this.restartContinuationStore = dependencies.restartContinuationStore;
    this.restartDispatchPlanOptions = dependencies.restartDispatchPlanOptions;
    this.registrySessionId = dependencies.registrySessionId;
    this.runningTurnShutdownStopTimeoutMs = dependencies.runningTurnShutdownStopTimeoutMs;
    this.resolveLiveProfileRuntimeInstanceIdsFn = dependencies.resolveLiveProfileRuntimeInstanceIdsFn;
    this.mcpConnectionService = dependencies.mcpConnectionService;
    this.providerThreadSnapshotStore = dependencies.providerThreadSnapshotStore;
    this.retainedOwnerThreadStorage = dependencies.retainedOwnerThreadStorage;
    this.codexProtocolCaptureSession = dependencies.codexProtocolCaptureSession;
    this.correspondenceStore = dependencies.correspondenceStore;
    this.pendingEnvironmentLaunchStore = dependencies.pendingEnvironmentLaunchStore;
    this.resolveCodexDefaultModeRequestUserInputFn = dependencies.resolveCodexDefaultModeRequestUserInputFn;
    this.resolveCodexToolDiscoveryFn = dependencies.resolveCodexToolDiscoveryFn;
    this.resolveDefaultPrAutoDispatchEnabledFn = dependencies.resolveDefaultPrAutoDispatchEnabledFn;
    this.resolveProviderModelDefaultsFn = dependencies.resolveProviderModelDefaultsFn;
    this.resolveHelperModelSettingsFn = dependencies.resolveHelperModelSettingsFn;
    this.resolveTaskMonitorModelsFn = dependencies.resolveTaskMonitorModelsFn;
    this.resolvePassSetupVariablesToAgentsFn = dependencies.resolvePassSetupVariablesToAgentsFn;
    this.resolveUsageAccountGroupsFn = dependencies.resolveUsageAccountGroupsFn;
    this.resolveProviderThreadModelMigrationsFn = dependencies.resolveProviderThreadModelMigrationsFn;
    this.resolveCodexLocalModelIdsFn = dependencies.resolveCodexLocalModelIdsFn;
    this.resolveCodexModelProvidersFn = dependencies.resolveCodexModelProvidersFn;
    this.resolveCodexModelProviderKeysFn = dependencies.resolveCodexModelProviderKeysFn;
    this.resolveCodexFastAllowedFn = dependencies.resolveCodexFastAllowedFn;
    this.resolvePdfAnalysisEnabledFn = dependencies.resolvePdfAnalysisEnabledFn;
    this.acpSessionIdleCloseMs = dependencies.acpSessionIdleCloseMs;
    this.resolveTokenMiserEnabledFn = dependencies.resolveTokenMiserEnabledFn;
    this.resolveTokenMiserDefaultEnabledFn = dependencies.resolveTokenMiserDefaultEnabledFn;
    this.resolveTokenMiserPollingReviewsEnabledFn = dependencies.resolveTokenMiserPollingReviewsEnabledFn;
    this.resolveManagedTokenMiserActivationRequiredFn = dependencies.resolveManagedTokenMiserActivationRequiredFn;
    this.resolveCodexDiscoveryPendingFn = dependencies.resolveCodexDiscoveryPendingFn;
    this.resolveToolOutputAlertPolicyFn = dependencies.resolveToolOutputAlertPolicyFn;
    this.resolveSpendAlertPolicyFn = dependencies.resolveSpendAlertPolicyFn;
    this.spendAlertPolicy = dependencies.spendAlertPolicy;
    this.toolOutputAlertPolicy = dependencies.toolOutputAlertPolicy;
    this.resolveCodexRuntimeCommandFn = dependencies.resolveCodexRuntimeCommandFn;
    this.resolveTokenMiserCodexRuntimeFn = dependencies.resolveTokenMiserCodexRuntimeFn;
    this.codexEnvironmentCommandEnv = dependencies.codexEnvironmentCommandEnv;
    this.localFilePrivateStorageRoots = dependencies.localFilePrivateStorageRoots;
    this.codexClient = dependencies.codexClient;
    this.tokenMiserDiagnostics = dependencies.tokenMiserDiagnostics;
    this.tokenMiserStore = dependencies.tokenMiserStore;
    this.tokenMiserService = dependencies.tokenMiserService;
    this.tokenMiserHookBridge = dependencies.tokenMiserHookBridge;
    this.tokenMiserCodeModeReducerDescriptorPath = dependencies.tokenMiserCodeModeReducerDescriptorPath;
    this.tokenMiserStateDir = dependencies.tokenMiserStateDir;
    this.tokenMiserPluginManager = dependencies.tokenMiserPluginManager;
    this.acpWorktreeRepositoryResolver = dependencies.acpWorktreeRepositoryResolver;
    this.acpAvailableCommandsStore = dependencies.acpAvailableCommandsStore;
    this.acpAvailableCommandProbeBudgetMs = dependencies.acpAvailableCommandProbeBudgetMs;
    this.overlayStore = dependencies.overlayStore;
    this.mcpGatewayTools = dependencies.mcpGatewayTools;
    this.gitDirectoryService = dependencies.gitDirectoryService;
    this.gitWorkingStateService = dependencies.gitWorkingStateService;
    this.worktreeArchiveService = dependencies.worktreeArchiveService;
    this.worktreeRecoveryService = dependencies.worktreeRecoveryService;
    this.pdfToolMcpServer = dependencies.pdfToolMcpServer;
    this.claudeAgentToolMcpServer = dependencies.claudeAgentToolMcpServer;
    this.claudeBackend = dependencies.claudeBackend;
    this.acpBackend = dependencies.acpBackend;
    this.acpSessionRuntimeOptions = dependencies.acpSessionRuntimeOptions;
    this.threadModelSettings = dependencies.threadModelSettings;
    this.providerRuntimeFingerprints = dependencies.providerRuntimeFingerprints;
    this.messagingStore = dependencies.messagingStore;
    this.appManagementHandler = dependencies.handlers.appManagementHandler;
    this.starMapHandler = dependencies.handlers.starMapHandler;
    this.resolveAcpHelperWorkspace = dependencies.resolveAcpHelperWorkspace;
    this.createScratchProjectDirectory = dependencies.createScratchProjectDirectory;
    this.createScheduledThreadActionFn = dependencies.handlers.createScheduledThreadActionFn;
    this.threadTitleGenerationService = dependencies.threadTitleGenerationService;
    this.threadInspectionTools = dependencies.threadInspectionTools;
    this.threadMcpConnections = dependencies.threadMcpConnections;
    this.headlessAutomation = dependencies.headlessAutomation;
    this.managedReviewService = dependencies.managedReviewService;
    this.subAgentMonitorService = dependencies.subAgentMonitorService;
    this.threadUsageLedger = dependencies.threadUsageLedger;
    this.threadArchiveCoordinator = dependencies.threadArchiveCoordinator;
    this.threadWorkspaceService = dependencies.threadWorkspaceService;
    this.threadDirectoryService = dependencies.threadDirectoryService;
    this.codexRuntimeSupervisor = dependencies.codexRuntimeSupervisor;
    this.codexModelProviderCatalog = dependencies.codexModelProviderCatalog;
    this.codexProviderCatalogRetry = dependencies.codexProviderCatalogRetry;
    this.modelCatalog = dependencies.modelCatalog;
    this.queuedMessageTitler = dependencies.queuedMessageTitler;
    this.threadTurnQueue = dependencies.threadTurnQueue;
    this.isCodexBootstrapDeferredFn = dependencies.isCodexBootstrapDeferredFn;
    this.isBootstrapModeFn = dependencies.isBootstrapModeFn;
    this.planLimits = dependencies.planLimits;
    this.captureStores = dependencies.captureStores;
    this.forgeToolBridge = dependencies.forgeToolBridge;
    this.messagingAgentToolService = dependencies.handlers.messagingAgentToolService;
    this.automationInspectionHandler = dependencies.handlers.automationInspectionHandler;
    this.federationHandler = dependencies.handlers.federationHandler;
    this.starMapIntakeFederationHandlerFactory = dependencies.handlers.starMapIntakeFederationHandlerFactory;
    this.agentThreadActions = dependencies.handlers.agentThreadActions;
    this.threadTodoHandler = dependencies.handlers.threadTodoHandler;
    this.federatedThreadMessageHandler = dependencies.handlers.federatedThreadMessageHandler;
    this.federatedThreadInspectionHandler = dependencies.handlers.federatedThreadInspectionHandler;
    this.federatedThreadControlHandler = dependencies.handlers.federatedThreadControlHandler;
    this.threadDependencyToolHandler = dependencies.handlers.threadDependencyToolHandler;
    this.agentFollowUpToolHandler = dependencies.handlers.agentFollowUpToolHandler;
    this.directoryGitStatusWriter = dependencies.handlers.directoryGitStatusWriter;
    this.threadPrAutoDispatchHandler = dependencies.handlers.threadPrAutoDispatchHandler;
    this.threadDependenciesPeerHandler = dependencies.handlers.threadDependenciesPeerHandler;
    this.threadGitWorkingStateRefreshHandler = dependencies.handlers.threadGitWorkingStateRefreshHandler;
    // Providers call back into the registry; bind only after every dependency is assigned.
    connect(this.constructionPorts());

    this.taskMonitorWatchdogTimer = setInterval(() => {
      void this.subAgentMonitorService.checkStaleTaskMonitors().catch((error) => {
        backendRegistryLog.warn("task monitor stale watchdog failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, TASK_MONITOR_STALE_CHECK_INTERVAL_MS);
    this.taskMonitorWatchdogTimer.unref?.();

    this.subscribeClient("codex", this.codexClient);
    // Every thread/resume the client sends carries the thread's current Agent
    // instructions, whichever operation happens to load the thread.
    this.codexClient.provideThreadDeveloperInstructions?.(async (threadId) =>
      providerDeliveredAgentInstructions(
        (await this.overlayStore.getThreadOverlayState({ backend: "codex", threadId }))?.agent,
      ));

    this.subAgentStartupReconciliation =
      this.subAgentMonitorService.reconcileOrphanedThreadSubAgentsAtStartup().catch((error) => {
        backendRegistryLog.warn("sub-agent-startup-reconciliation-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    // The one-time move of usage activities out of overlay rows, after the
    // card repair. Sliced, and a no-op once the profile's marker is set.
    // Nothing waits for it: a row it has not reached moves on first touch.
    void this.subAgentStartupReconciliation
      .then(() => this.overlayStore.moveLegacyThreadUsageActivities?.())
      .catch((error: unknown) => {
        backendRegistryLog.warn("usage-activity-move-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    // Starts first: inferring an unfinished turn's end reads its start.
    this.usageTurnStartupRepair =
      this.threadUsageLedger.repairThreadUsageTurnTimesOnce()
        .catch((error) => {
          backendRegistryLog.warn("usage-turn-time-repair-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .then(() => this.threadUsageLedger.repairUnfinishedThreadUsageTurnsAtStartup())
        .catch((error) => {
          backendRegistryLog.warn("usage-turn-startup-repair-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });

    // Kick off a one-shot scan of persisted codexEnvironmentRuntime
    // entries: zombie "started" runs from a prior session become
    // "failed", and output bytes get cleared on anything finished
    // before this session started. Fire-and-forget — the renderer's
    // session-startedAt filter already hides stale entries from view,
    // so this is purely about reclaiming sqlite bytes and tidying
    // persisted state. Errors are swallowed; this can't break startup.
    void this.cleanupStaleCodexEnvironmentRuntimes().catch((error) => {
      backendRegistryLog.warn("codex-environment-startup-cleanup-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Callback ports for composition only; feature modules use RegistryContext. */
  constructionPorts() {
    const current = () => this;
    return {
      get acceptedHandoffTaskRequests() { return current().acceptedHandoffTaskRequests; },
      get acpBackend() { return current().acpBackend; },
      get acpWorktreeRepositoryResolver() { return current().acpWorktreeRepositoryResolver; },
      get acpSessionPromptLocks() { return current().acpSessionPromptLocks; },
      admitNewThreadModelSettings: (...args: Parameters<typeof this.admitNewThreadModelSettings>) => this.admitNewThreadModelSettings(...args),
      get agentThreadActions() { return current().agentThreadActions; },
      get appManagementHandler() { return current().appManagementHandler; },
      get currentTurnInputSource() { return current().currentTurnInputSource; },
      get messagingWorkingUpdatesHandler() { return current().messagingWorkingUpdatesHandler; },
      applyAcpRuntimeSelection: (...args: Parameters<typeof this.applyAcpRuntimeSelection>) => this.applyAcpRuntimeSelection(...args),
      applyQueuedMessageTitle: (...args: Parameters<typeof this.applyQueuedMessageTitle>) => this.applyQueuedMessageTitle(...args),
      approveGatewayInvocation: (...args: Parameters<ThreadMcpConnections["approveGatewayInvocation"]>) => this.threadMcpConnections.approveGatewayInvocation(...args),
      appendPermissionTransition: (...args: Parameters<typeof this.appendPermissionTransition>) => this.appendPermissionTransition(...args),
      archiveThread: (...args: Parameters<ThreadArchiveCoordinator["archiveThread"]>) => this.threadArchiveCoordinator.archiveThread(...args),
      assertNotBootstrap: (...args: Parameters<typeof this.assertNotBootstrap>) => this.assertNotBootstrap(...args),
      assertThreadNotHandingOff: (...args: Parameters<typeof this.assertThreadNotHandingOff>) => this.assertThreadNotHandingOff(...args),
      assertThreadNotLocked: (...args: Parameters<typeof this.assertThreadNotLocked>) => this.assertThreadNotLocked(...args),
      deleteOwnedThreadAssets: (owner: ThreadAssetOwner) => this.deleteOwnedThreadAssets(owner),
      assertThreadOwnership: (...args: Parameters<typeof this.assertThreadOwnership>) => this.assertThreadOwnership(...args),
      attributeCodexProviderUsage: (...args: Parameters<typeof this.attributeCodexProviderUsage>) => this.attributeCodexProviderUsage(...args),
      authorizeAgentToolMcpCall: (...args: Parameters<typeof this.authorizeAgentToolMcpCall>) => this.authorizeAgentToolMcpCall(...args),
      canManagePwrAgent: (...args: Parameters<typeof this.canManagePwrAgent>) => this.canManagePwrAgent(...args),
      get automationInspectionHandler() { return current().automationInspectionHandler; },
      beginStartingTurnOrigin: (...args: Parameters<typeof this.beginStartingTurnOrigin>) => this.beginStartingTurnOrigin(...args),
      bindStartingTurnOrigin: (...args: Parameters<typeof this.bindStartingTurnOrigin>) => this.bindStartingTurnOrigin(...args),
      buildForkedCodexEnvironmentRuntime: (...args: Parameters<ThreadDirectoryService["buildForkedCodexEnvironmentRuntime"]>) => this.threadDirectoryService.buildForkedCodexEnvironmentRuntime(...args),
      buildSupportedCodexDynamicToolsRefresh: (...args: Parameters<typeof this.buildSupportedCodexDynamicToolsRefresh>) => this.buildSupportedCodexDynamicToolsRefresh(...args),
      buildSupportedCodexTokenMiserConfig: (...args: Parameters<typeof this.buildSupportedCodexTokenMiserConfig>) => this.buildSupportedCodexTokenMiserConfig(...args),
      buildSupportedPwrdrvrTokenMiserActivation: (...args: Parameters<typeof this.buildSupportedPwrdrvrTokenMiserActivation>) => this.buildSupportedPwrdrvrTokenMiserActivation(...args),
      buildTaskMonitorForgeToolDefinitions: (...args: Parameters<ForgeToolBridge["buildTaskMonitorForgeToolDefinitions"]>) => this.forgeToolBridge.buildTaskMonitorForgeToolDefinitions(...args),
      canStartThreadTurnImmediately: (...args: Parameters<typeof this.canStartThreadTurnImmediately>) => this.canStartThreadTurnImmediately(...args),
      captureUsageAccount: (...args: Parameters<typeof this.captureUsageAccount>) => this.captureUsageAccount(...args),
      checkThreadBranchDrift: (...args: Parameters<typeof this.checkThreadBranchDrift>) => this.checkThreadBranchDrift(...args),
      get checkoutRestores() { return current().threadArchiveCoordinator.checkoutRestoreRecords; },
      clearMissingCodexThread: (...args: Parameters<typeof this.clearMissingCodexThread>) => this.clearMissingCodexThread(...args),
      get closed() { return current().closed; },
      get codexBackendSummary() { return current().codexBackendSummary; },
      get codexBackgroundTerminals() { return current().codexRuntimeSupervisor.backgroundTerminalRecords; },
      get codexClient() { return current().codexClient; },
      codexThreadBoundToAppServer: (threadId: string) => current().codexRuntimeSupervisor.codexThreadBoundToAppServer(threadId),
      codexThreadNeedsLiveEvents: (threadId: string) => current().codexRuntimeSupervisor.codexThreadNeedsLiveEvents(threadId),
      handleCodexAppServerGenerationPromoted: (...args: Parameters<typeof this.handleCodexAppServerGenerationPromoted>) => this.handleCodexAppServerGenerationPromoted(...args),
      get codexEnvironmentCommandEnv() { return current().codexEnvironmentCommandEnv; },
      get codexModelProviderCatalog() { return current().codexModelProviderCatalog; },
      get codexModelProviderKeysRead() { return current().codexModelProviderKeysRead; },
      set codexModelProviderKeysRead(value) { current().codexModelProviderKeysRead = value; },
      get codexRuntimeRestartPending() { return current().codexRuntimeSupervisor.runtimeRestartPending; },
      set codexRuntimeRestartPending(value) { current().codexRuntimeSupervisor.setRuntimeRestartPending(value); },
      compactThreadNow: (...args: Parameters<typeof this.compactThreadNow>) => this.compactThreadNow(...args),
      get configStore() { return current().configStore; },
      get createScheduledThreadActionFn() { return current().createScheduledThreadActionFn; },
      get createScratchProjectDirectory() { return current().createScratchProjectDirectory; },
      deliverProjectPausedWakeup: (...args: Parameters<typeof this.deliverProjectPausedWakeup>) => this.deliverProjectPausedWakeup(...args),
      deriveLiveThreadTokenUsage: (...args: Parameters<ThreadUsageLedger["deriveLiveThreadTokenUsage"]>) => this.threadUsageLedger.deriveLiveThreadTokenUsage(...args),
      dispatchMessagingRequest: (...args: Parameters<typeof this.dispatchMessagingRequest>) => this.dispatchMessagingRequest(...args),
      drainPendingThreadWorkspaceMovesForTerminalTurn: (...args: Parameters<ThreadWorkspaceService["drainPendingThreadWorkspaceMovesForTerminalTurn"]>) => this.threadWorkspaceService.drainPendingThreadWorkspaceMovesForTerminalTurn(...args),
      dropStartingTurnOrigin: (...args: Parameters<typeof this.dropStartingTurnOrigin>) => this.dropStartingTurnOrigin(...args),
      dynamicToolPermissionDenied: (...args: Parameters<typeof this.dynamicToolPermissionDenied>) => this.dynamicToolPermissionDenied(...args),
      emit: (...args: Parameters<typeof this.emit>) => this.emit(...args),
      emitThreadPricingUpdated: (...args: Parameters<ThreadUsageLedger["emitThreadPricingUpdated"]>) => this.threadUsageLedger.emitThreadPricingUpdated(...args),
      emitThreadToolAccountingUpdated: (...args: Parameters<ThreadUsageLedger["emitThreadToolAccountingUpdated"]>) => this.threadUsageLedger.emitThreadToolAccountingUpdated(...args),
      emitToListeners: (...args: Parameters<typeof this.emitToListeners>) => this.emitToListeners(...args),
      emitTurnQueueLifecycle: (...args: Parameters<typeof this.emitTurnQueueLifecycle>) => this.emitTurnQueueLifecycle(...args),
      ensureCheckoutAwake: (...args: Parameters<ThreadArchiveCoordinator["ensureCheckoutAwake"]>) => this.threadArchiveCoordinator.ensureCheckoutAwake(...args),
      ensureDirectoryLaunchpad: (...args: Parameters<ThreadDirectoryService["ensureDirectoryLaunchpad"]>) => this.threadDirectoryService.ensureDirectoryLaunchpad(...args),
      get federatedThreadInspectionHandler() { return current().federatedThreadInspectionHandler; },
      get federationHandler() { return current().federationHandler; },
      findHeadlessAutomationForThread: (...args: Parameters<typeof this.headlessAutomation.findHeadlessAutomationForThread>) => this.headlessAutomation.findHeadlessAutomationForThread(...args),
      findHeadlessAutomationTurnForRequest: (...args: Parameters<typeof this.headlessAutomation.findHeadlessAutomationTurnForRequest>) => this.headlessAutomation.findHeadlessAutomationTurnForRequest(...args),
      findReviewForParentTurn: (...args: Parameters<ManagedReviewService["findReviewForParentTurn"]>) => this.managedReviewService.findReviewForParentTurn(...args),
      findThreadForWorkspaceHandoff: (...args: Parameters<typeof this.findThreadForWorkspaceHandoff>) => this.findThreadForWorkspaceHandoff(...args),
      flushQueuedAgentChange: (...args: Parameters<typeof this.flushQueuedAgentChange>) => this.flushQueuedAgentChange(...args),
      flushQueuedExecutionModeIfPresent: (...args: Parameters<typeof this.flushQueuedExecutionModeIfPresent>) => this.flushQueuedExecutionModeIfPresent(...args),
      forkThread: (...args: Parameters<typeof this.forkThread>) => this.forkThread(...args),
      get gatedForgePrToolHandler() { return current().forgeToolBridge.gatedForgePrToolHandler; },
      get gatedForgeReadHandler() { return current().forgeToolBridge.gatedForgeReadHandler; },
      generateStructuredObject: (...args: Parameters<typeof this.generateStructuredObject>) => this.generateStructuredObject(...args),
      getActiveTurnForThread: (...args: Parameters<typeof this.getActiveTurnForThread>) => this.getActiveTurnForThread(...args),
      getBackendLaunchpadOptions: (...args: Parameters<typeof this.getBackendLaunchpadOptions>) => this.getBackendLaunchpadOptions(...args),
      projectOutpostLaunchpadSettings: <T extends NavigationLaunchpadDefaults>(settings: T, options?: BackendLaunchpadOptions) =>
        this.projectOutpostLaunchpadSettings(settings, options),
      getCachedThreadSummary: (...args: Parameters<typeof this.getCachedThreadSummary>) => this.getCachedThreadSummary(...args),
      getClient: (...args: Parameters<typeof this.getClient>) => this.getClient(...args),
      getPendingThreadHandoffsForInspection: (...args: Parameters<ThreadWorkspaceService["getPendingThreadHandoffsForInspection"]>) => this.threadWorkspaceService.getPendingThreadHandoffsForInspection(...args),
      getPendingThreadWorkspaceMovesForInspection: (...args: Parameters<ThreadWorkspaceService["getPendingThreadWorkspaceMovesForInspection"]>) => this.threadWorkspaceService.getPendingThreadWorkspaceMovesForInspection(...args),
      getPendingTurnForThread: (...args: Parameters<typeof this.getPendingTurnForThread>) => this.getPendingTurnForThread(...args),
      getQueuedExecutionModesSnapshot: (...args: Parameters<typeof this.getQueuedExecutionModesSnapshot>) => this.getQueuedExecutionModesSnapshot(...args),
      getTurnInputAttachments: (...args: Parameters<typeof this.getTurnInputAttachments>) => this.getTurnInputAttachments(...args),
      get gitDirectoryService() { return current().gitDirectoryService; },
      get gitWorkingStateService() { return current().gitWorkingStateService; },
      handleAgentMcpConnectionRequest: (...args: Parameters<ThreadMcpConnections["handleAgentMcpConnectionRequest"]>) => this.threadMcpConnections.handleAgentMcpConnectionRequest(...args),
      handleAgentTaskMonitorRequest: (...args: Parameters<SubAgentMonitorService["handleAgentTaskMonitorRequest"]>) => this.subAgentMonitorService.handleAgentTaskMonitorRequest(...args),
      handleCodexAppServerUnexpectedExit: (...args: Parameters<typeof this.codexRuntimeSupervisor.handleCodexAppServerUnexpectedExit>) => this.codexRuntimeSupervisor.handleCodexAppServerUnexpectedExit(...args),
      handleServerRequest: (...args: Parameters<typeof this.handleServerRequest>) => this.handleServerRequest(...args),
      handoffThreadWorkspace: (...args: Parameters<ThreadWorkspaceService["handoffThreadWorkspace"]>) => this.threadWorkspaceService.handoffThreadWorkspace(...args),
      hasActiveCodexWork: (...args: Parameters<typeof this.hasActiveCodexWork>) => this.hasActiveCodexWork(...args),
      holdBackendSelfStartedTurn: (...args: Parameters<typeof this.holdBackendSelfStartedTurn>) => this.holdBackendSelfStartedTurn(...args),
      initializeTokenMiserLedger: (...args: Parameters<ThreadUsageLedger["initializeTokenMiserLedger"]>) => this.threadUsageLedger.initializeTokenMiserLedger(...args),
      interruptTurn: (...args: Parameters<typeof this.interruptTurn>) => this.interruptTurn(...args),
      invalidateProviderRuntimeSelections: (...args: Parameters<typeof this.invalidateProviderRuntimeSelections>) => this.invalidateProviderRuntimeSelections(...args),
      invalidateThreadListCache: (...args: Parameters<typeof this.invalidateThreadListCache>) => this.invalidateThreadListCache(...args),
      get isBootstrapModeFn() { return current().isBootstrapModeFn; },
      get isCodexBootstrapDeferredFn() { return current().isCodexBootstrapDeferredFn; },
      isCodexThreadKnownMissing: (...args: Parameters<typeof this.isCodexThreadKnownMissing>) => this.isCodexThreadKnownMissing(...args),
      isLiveDynamicToolCall: (...args: Parameters<typeof this.isLiveDynamicToolCall>) => this.isLiveDynamicToolCall(...args),
      isMcpGatewayFullAccess: (...args: Parameters<ThreadMcpConnections["isMcpGatewayFullAccess"]>) => this.threadMcpConnections.isMcpGatewayFullAccess(...args),
      isQueuedMessageTitleCurrent: (...args: Parameters<typeof this.isQueuedMessageTitleCurrent>) => this.isQueuedMessageTitleCurrent(...args),
      isTaskMonitorThread: (...args: Parameters<SubAgentMonitorService["isTaskMonitorThread"]>) => this.subAgentMonitorService.isTaskMonitorThread(...args),
      listActiveCodexWorkThreadIds: (...args: Parameters<typeof this.listActiveCodexWorkThreadIds>) => this.listActiveCodexWorkThreadIds(...args),
      listAllInstalledAcpThreads: (...args: Parameters<typeof this.listAllInstalledAcpThreads>) => this.listAllInstalledAcpThreads(...args),
      listBackends: (...args: Parameters<typeof this.listBackends>) => this.listBackends(...args),
      listThreads: (...args: Parameters<typeof this.listThreads>) => this.listThreads(...args),
      liveProfileRuntimeInstanceIds: (...args: Parameters<typeof this.liveProfileRuntimeInstanceIds>) => this.liveProfileRuntimeInstanceIds(...args),
      liveSubAgentMonitorIds: (...args: Parameters<typeof this.liveSubAgentMonitorIds>) => this.liveSubAgentMonitorIds(...args),
      get liveThreadReplayInputCursor() { return current().threadUsageLedger.liveThreadReplayInputCursorRecords; },
      get localFilePrivateStorageRoots() { return current().localFilePrivateStorageRoots; },
      get managedCodexRuntimeSwitchPending() { return current().codexRuntimeSupervisor.managedRuntimeSwitchPending; },
      set managedCodexRuntimeSwitchPending(value) { current().codexRuntimeSupervisor.setManagedRuntimeSwitchPending(value); },
      maybeRestartCodexForManagedRuntimeChange: (...args: Parameters<typeof this.codexRuntimeSupervisor.maybeRestartCodexForManagedRuntimeChange>) => this.codexRuntimeSupervisor.maybeRestartCodexForManagedRuntimeChange(...args),
      requestCodexRuntimeSwitch: () => current().codexRuntimeSupervisor.requestCodexRuntimeSwitch(),
      get mcpConnectionService() { return current().mcpConnectionService; },
      get mcpGatewayTools() { return current().mcpGatewayTools; },
      get messagingHandler() { return current().messagingHandler; },
      get messagingStore() { return current().messagingStore; },
      get modelCatalog() { return current().modelCatalog; },
      get nativeVoiceLeases() { return current().nativeVoiceLeases; },
      observeLiveThreadContextReplay: (...args: Parameters<ThreadUsageLedger["observeLiveThreadContextReplay"]>) => this.threadUsageLedger.observeLiveThreadContextReplay(...args),
      observeTurnFailure: (...args: Parameters<typeof this.observeTurnFailure>) => this.observeTurnFailure(...args),
      observeTurnListeners: (...args: Parameters<typeof this.observeTurnListeners>) => this.observeTurnListeners(...args),
      observeTurnMessageContext: (...args: Parameters<typeof this.observeTurnMessageContext>) => this.observeTurnMessageContext(...args),
      observeTurnNotifications: (...args: Parameters<typeof this.observeTurnNotifications>) => this.observeTurnNotifications(...args),
      observeTurnRequestResolution: (...args: Parameters<typeof this.observeTurnRequestResolution>) => this.observeTurnRequestResolution(...args),
      observeTurnStarted: (...args: Parameters<typeof this.observeTurnStarted>) => this.observeTurnStarted(...args),
      observeTurnStatus: (...args: Parameters<typeof this.observeTurnStatus>) => this.observeTurnStatus(...args),
      observeTurnStatusQueue: (...args: Parameters<typeof this.observeTurnStatusQueue>) => this.observeTurnStatusQueue(...args),
      observeTurnTerminalActivity: (...args: Parameters<typeof this.observeTurnTerminalActivity>) => this.observeTurnTerminalActivity(...args),
      observeTurnTerminalModes: (...args: Parameters<typeof this.observeTurnTerminalModes>) => this.observeTurnTerminalModes(...args),
      observeTurnTerminalQueue: (...args: Parameters<typeof this.observeTurnTerminalQueue>) => this.observeTurnTerminalQueue(...args),
      observeTurnTerminalRequests: (...args: Parameters<typeof this.observeTurnTerminalRequests>) => this.observeTurnTerminalRequests(...args),
      observeTurnTerminalResources: (...args: Parameters<typeof this.observeTurnTerminalResources>) => this.observeTurnTerminalResources(...args),
      observeTurnThreadState: (...args: Parameters<typeof this.observeTurnThreadState>) => this.observeTurnThreadState(...args),
      get overlayStore() { return current().overlayStore; },
      ownerRelativeInstanceId: (...args: Parameters<typeof this.ownerRelativeInstanceId>) => this.ownerRelativeInstanceId(...args),
      get pendingEnvironmentLaunchStore() { return current().pendingEnvironmentLaunchStore; },
      get pendingServerRequests() { return current().pendingServerRequests; },
      get pendingStartedThreads() { return current().pendingStartedThreads; },
      persistStartingTurnOrigin: (...args: Parameters<typeof this.persistStartingTurnOrigin>) => this.persistStartingTurnOrigin(...args),
      get planLimits() { return current().planLimits; },
      prepareTokenMiserRuntime: (...args: Parameters<typeof this.prepareTokenMiserRuntime>) => this.prepareTokenMiserRuntime(...args),
      publishIncomingWork: (...args: Parameters<typeof this.publishIncomingWork>) => this.publishIncomingWork(...args),
      publishLiveTokenMiserLedgerEntryInOrder: (...args: Parameters<ThreadUsageLedger["publishLiveTokenMiserLedgerEntryInOrder"]>) => this.threadUsageLedger.publishLiveTokenMiserLedgerEntryInOrder(...args),
      publishLocalEvent: (...args: Parameters<typeof this.publishLocalEvent>) => this.publishLocalEvent(...args),
      readCausalMessagingContext: (...args: Parameters<typeof this.readCausalMessagingContext>) => this.readCausalMessagingContext(...args),
      readTurnCausalMessagingOrigin: (context: Parameters<typeof this.readTurnCausalMessagingOrigin>[0]) => this.readTurnCausalMessagingOrigin(context),
      readCodexDefaultModelsOnce: (...args: Parameters<typeof this.readCodexDefaultModelsOnce>) => this.readCodexDefaultModelsOnce(...args),
      readDelegatedTurnAncestry: (...args: Parameters<typeof this.readDelegatedTurnAncestry>) => this.readDelegatedTurnAncestry(...args),
      readMcpGatewaySelection: (...args: Parameters<ThreadMcpConnections["readMcpGatewaySelection"]>) => this.threadMcpConnections.readMcpGatewaySelection(...args),
      readThread: (...args: Parameters<typeof this.readThread>) => this.readThread(...args),
      readThreadInspectionSummaryForMutation: (...args: Parameters<ThreadInspectionTools["readThreadInspectionSummaryForMutation"]>) => this.threadInspectionTools.readThreadInspectionSummaryForMutation(...args),
      readThreadLock: (...args: Parameters<typeof this.readThreadLock>) => this.readThreadLock(...args),
      readThreadUsageActivities: (...args: Parameters<ThreadUsageLedger["readThreadUsageActivities"]>) => this.threadUsageLedger.readThreadUsageActivities(...args),
      get recentlyCompletedThreadUsageTurns() { return current().threadUsageLedger.recentlyCompletedThreadUsageTurnRecords; },
      recordClaudeSubAgents: (...args: Parameters<SubAgentMonitorService["recordClaudeSubAgents"]>) => this.subAgentMonitorService.recordClaudeSubAgents(...args),
      recordCodexWorktreeOwnerThread: (...args: Parameters<typeof this.recordCodexWorktreeOwnerThread>) => this.recordCodexWorktreeOwnerThread(...args),
      recordMissingCodexThread: (...args: Parameters<typeof this.recordMissingCodexThread>) => this.recordMissingCodexThread(...args),
      recordQueuedMessageTitle: (...args: Parameters<typeof this.recordQueuedMessageTitle>) => this.recordQueuedMessageTitle(...args),
      recordTokenMiserFocusedInference: (...args: Parameters<ThreadUsageLedger["recordTokenMiserFocusedInference"]>) => this.threadUsageLedger.recordTokenMiserFocusedInference(...args),
      redescribeCachedCodexRuntime: (...args: Parameters<typeof this.redescribeCachedCodexRuntime>) => this.redescribeCachedCodexRuntime(...args),
      refreshCodexProviderCatalogs: (...args: Parameters<typeof this.refreshCodexProviderCatalogs>) => this.refreshCodexProviderCatalogs(...args),
      retryCodexProviderCatalogs: () => this.retryCodexProviderCatalogs(),
      applyCodexModelProviderConfigChange: () => this.applyCodexModelProviderConfigChange(),
      registerAcpMcpConnections: (...args: Parameters<ThreadMcpConnections["registerAcpMcpConnections"]>) => this.threadMcpConnections.registerAcpMcpConnections(...args),
      get registrySessionId() { return current().registrySessionId; },
      get registrySessionStartedAt() { return current().registrySessionStartedAt; },
      rememberAcpAvailableCommands: (...args: Parameters<typeof this.rememberAcpAvailableCommands>) => this.rememberAcpAvailableCommands(...args),
      rememberActiveTokenMiserReplayEntry: (...args: Parameters<ThreadUsageLedger["rememberActiveTokenMiserReplayEntry"]>) => this.threadUsageLedger.rememberActiveTokenMiserReplayEntry(...args),
      rememberPendingTokenMiserInterception: (...args: Parameters<ThreadUsageLedger["rememberPendingTokenMiserInterception"]>) => this.threadUsageLedger.rememberPendingTokenMiserInterception(...args),
      renameThread: (...args: Parameters<typeof this.renameThread>) => this.renameThread(...args),
      replaceWorkspaceLinkedDirectory: (...args: Parameters<ThreadDirectoryService["replaceWorkspaceLinkedDirectory"]>) => this.threadDirectoryService.replaceWorkspaceLinkedDirectory(...args),
      requestUpstreamMcpForm: (...args: Parameters<ThreadMcpConnections["requestUpstreamMcpForm"]>) => this.threadMcpConnections.requestUpstreamMcpForm(...args),
      get reservedAcpStartThreadKeys() { return current().reservedAcpStartThreadKeys; },
      resolveAgentCallerExecutionMode: (...args: Parameters<typeof this.resolveAgentCallerExecutionMode>) => this.resolveAgentCallerExecutionMode(...args),
      resolveAgentToolMcpCallContext: (...args: Parameters<typeof this.resolveAgentToolMcpCallContext>) => this.resolveAgentToolMcpCallContext(...args),
      resolveClaudeToolCallExecutionMode: (...args: Parameters<typeof this.resolveClaudeToolCallExecutionMode>) => this.resolveClaudeToolCallExecutionMode(...args),
      get resolveCodexFastAllowedFn() { return current().resolveCodexFastAllowedFn; },
      get resolveCodexLocalModelIdsFn() { return current().resolveCodexLocalModelIdsFn; },
      get resolveCodexModelProviderKeysFn() { return current().resolveCodexModelProviderKeysFn; },
      get resolveCodexModelProvidersFn() { return current().resolveCodexModelProvidersFn; },
      resolveCodexThreadExecutionModeForActiveTurn: (...args: Parameters<typeof this.resolveCodexThreadExecutionModeForActiveTurn>) => this.resolveCodexThreadExecutionModeForActiveTurn(...args),
      resolveCodexToolCallExecutionMode: (...args: Parameters<typeof this.resolveCodexToolCallExecutionMode>) => this.resolveCodexToolCallExecutionMode(...args),
      get resolveDefaultPrAutoDispatchEnabledFn() { return current().resolveDefaultPrAutoDispatchEnabledFn; },
      resolveForgeToolPolicy: (...args: Parameters<ForgeToolBridge["resolveForgeToolPolicy"]>) => this.forgeToolBridge.resolveForgeToolPolicy(...args),
      resolveHandoffSourceExecutionMode: (...args: Parameters<typeof this.resolveHandoffSourceExecutionMode>) => this.resolveHandoffSourceExecutionMode(...args),
      get resolveHelperModelSettingsFn() { return current().resolveHelperModelSettingsFn; },
      get resolveLiveProfileRuntimeInstanceIdsFn() { return current().resolveLiveProfileRuntimeInstanceIdsFn; },
      resolveModelSettings: (...args: Parameters<typeof this.resolveModelSettings>) => this.resolveModelSettings(...args),
      get resolvePassSetupVariablesToAgentsFn() { return current().resolvePassSetupVariablesToAgentsFn; },
      resolvePausedThreadProject: (...args: Parameters<typeof this.resolvePausedThreadProject>) => this.resolvePausedThreadProject(...args),
      get resolveProviderModelDefaultsFn() { return current().resolveProviderModelDefaultsFn; },
      resolveReviewContext: (...args: Parameters<ManagedReviewService["resolveReviewContext"]>) => this.managedReviewService.resolveReviewContext(...args),
      get resolveSpendAlertPolicyFn() { return current().resolveSpendAlertPolicyFn; },
      get resolveTaskMonitorModelsFn() { return current().resolveTaskMonitorModelsFn; },
      resolveThread: (...args: Parameters<typeof this.resolveThread>) => this.resolveThread(...args),
      resolveThreadEnvironmentCwd: (...args: Parameters<typeof this.resolveThreadEnvironmentCwd>) => this.resolveThreadEnvironmentCwd(...args),
      resolveThreadMcpRootDirectories: (...args: Parameters<ThreadMcpConnections["resolveThreadMcpRootDirectories"]>) => this.threadMcpConnections.resolveThreadMcpRootDirectories(...args),
      get resolveTokenMiserDefaultEnabledFn() { return current().resolveTokenMiserDefaultEnabledFn; },
      get resolveTokenMiserEnabledFn() { return current().resolveTokenMiserEnabledFn; },
      resolveTokenMiserEnabledForOverride: (...args: Parameters<typeof this.resolveTokenMiserEnabledForOverride>) => this.resolveTokenMiserEnabledForOverride(...args),
      resolveTokenMiserParentModel: (...args: Parameters<ThreadUsageLedger["resolveTokenMiserParentModel"]>) => this.threadUsageLedger.resolveTokenMiserParentModel(...args),
      get resolveTokenMiserPollingReviewsEnabledFn() { return current().resolveTokenMiserPollingReviewsEnabledFn; },
      resolveTokenMiserThreadOverride: (...args: Parameters<typeof this.resolveTokenMiserThreadOverride>) => this.resolveTokenMiserThreadOverride(...args),
      get resolveToolOutputAlertPolicyFn() { return current().resolveToolOutputAlertPolicyFn; },
      get restartGate() { return current().restartGate; },
      restoreProjectHeldWakeups: (...args: Parameters<typeof this.restoreProjectHeldWakeups>) => this.restoreProjectHeldWakeups(...args),
      restoreRestartContinuations: (...args: Parameters<typeof this.restoreRestartContinuations>) => this.restoreRestartContinuations(...args),
      restoreThread: (...args: Parameters<ThreadArchiveCoordinator["restoreThread"]>) => this.threadArchiveCoordinator.restoreThread(...args),
      get runtimeInstanceId() { return current().runtimeInstanceId; },
      scheduleQueuedAgentChange: (...args: Parameters<typeof this.scheduleQueuedAgentChange>) => this.scheduleQueuedAgentChange(...args),
      scheduleThreadTitleGeneration: (...args: Parameters<typeof this.scheduleThreadTitleGeneration>) => this.scheduleThreadTitleGeneration(...args),
      setThreadExecutionMode: (...args: Parameters<typeof this.setThreadExecutionMode>) => this.setThreadExecutionMode(...args),
      setThreadLock: (...args: Parameters<typeof this.setThreadLock>) => this.setThreadLock(...args),
      setThreadModelSettings: (...args: Parameters<typeof this.setThreadModelSettings>) => this.setThreadModelSettings(...args),
      get shutdownRequested() { return current().shutdownRequested; },
      get spendAlertPolicy() { return current().spendAlertPolicy; },
      set spendAlertPolicy(value) { current().spendAlertPolicy = value; },
      get starMapHandler() { return current().starMapHandler; },
      startAcpSession: (...args: Parameters<typeof this.startAcpSession>) => this.startAcpSession(...args),
      startAcpTurn: (...args: Parameters<typeof this.startAcpTurn>) => this.startAcpTurn(...args),
      startReview: (...args: Parameters<typeof this.startReview>) => this.startReview(...args),
      startThread: (...args: Parameters<typeof this.startThread>) => this.startThread(...args),
      startTurn: (...args: Parameters<typeof this.startTurn>) => this.startTurn(...args),
      startTurnNow: (...args: Parameters<typeof this.startTurnNow>) => this.startTurnNow(...args),
      prepareQueuedTurnInput: (entry: ThreadTurnQueueEntry) => this.prepareQueuedTurnInput(entry),
      startTurnWithoutHandoff: (...args: Parameters<typeof this.startTurnWithoutHandoff>) => this.startTurnWithoutHandoff(...args),
      steerTurn: (...args: Parameters<typeof this.steerTurn>) => this.steerTurn(...args),
      get stoppingRunningTurnsForShutdown() { return current().stoppingRunningTurnsForShutdown; },
      get subAgentStartupReconciliation() { return current().subAgentStartupReconciliation; },
      submitHeldTurn: (...args: Parameters<typeof this.submitHeldTurn>) => this.submitHeldTurn(...args),
      submitTurn: (...args: Parameters<typeof this.submitTurn>) => this.submitTurn(...args),
      suggestClaudeMonitorJob: (...args: Parameters<ThreadUsageLedger["suggestClaudeMonitorJob"]>) => this.threadUsageLedger.suggestClaudeMonitorJob(...args),
      synchronizeProviderRuntimeSelections: (...args: Parameters<typeof this.synchronizeProviderRuntimeSelections>) => this.synchronizeProviderRuntimeSelections(...args),
      takeAcpMonitorJobSuggestion: (...args: Parameters<ThreadUsageLedger["takeAcpMonitorJobSuggestion"]>) => this.threadUsageLedger.takeAcpMonitorJobSuggestion(...args),
      get taskMonitorDelegations() { return current().subAgentMonitorService.taskMonitorDelegationRecords; },
      taskMonitorForThread: (...args: Parameters<SubAgentMonitorService["taskMonitorForThread"]>) => this.subAgentMonitorService.taskMonitorForThread(...args),
      get threadDependencyToolHandler() { return current().threadDependencyToolHandler; },
      get agentFollowUpToolHandler() { return current().agentFollowUpToolHandler; },
      isResearchWorker: (thread: { backend: AppServerBackendKind; threadId: string }) => current().researchWorkerCheck?.(thread) ?? false,
      get threadHandoffReservations() { return current().threadWorkspaceService.threadHandoffReservationRecords; },
      threadHasActiveCodexReviewTurn: (...args: Parameters<typeof this.threadHasActiveCodexReviewTurn>) => this.threadHasActiveCodexReviewTurn(...args),
      threadHasActiveTurn: (...args: Parameters<typeof this.threadHasActiveTurn>) => this.threadHasActiveTurn(...args),
      threadHasBlockingWorkspaceMove: (...args: Parameters<ThreadWorkspaceService["threadHasBlockingWorkspaceMove"]>) => this.threadWorkspaceService.threadHasBlockingWorkspaceMove(...args),
      get threadInfoStore() { return current().threadInfoStore; },
      get threadInspectionHandler() { return current().threadInspectionHandler; },
      get threadLifecycleLocks() { return current().threadLifecycleLocks; },
      get threadListCacheOwnerId() { return current().threadListCacheOwnerId; },
      threadMcpServerNameInAgent: (...args: Parameters<ThreadMcpConnections["threadMcpServerNameInAgent"]>) => this.threadMcpConnections.threadMcpServerNameInAgent(...args),
      get threadOrchestrationHandler() { return current().threadOrchestrationHandler; },
      get threadPrAutoDispatchHandler() { return current().threadPrAutoDispatchHandler; },
      get threadStarts() { return current().threadStarts; },
      get threadTodoHandler() { return current().threadTodoHandler; },
      get openAIDecisionsHandler() { return current().openAIDecisionsHandler; },
      get checkoutHandler() { return current().checkoutHandler; },
      get mcpResearchHandler() { return current().mcpResearchHandler; },
      get threadTurnQueue() { return current().threadTurnQueue; },
      get tokenMiserCodeModeGroupingVersion() { return current().tokenMiserCodeModeGroupingVersion; },
      set tokenMiserCodeModeGroupingVersion(value) { current().tokenMiserCodeModeGroupingVersion = value; },
      get tokenMiserDiagnostics() { return current().tokenMiserDiagnostics; },
      get tokenMiserPostToolUseExactOutputVersion() { return current().tokenMiserPostToolUseExactOutputVersion; },
      set tokenMiserPostToolUseExactOutputVersion(value) { current().tokenMiserPostToolUseExactOutputVersion = value; },
      get tokenMiserReducerCapabilityState() { return current().tokenMiserReducerCapabilityState; },
      set tokenMiserReducerCapabilityState(value) { current().tokenMiserReducerCapabilityState = value; },
      get tokenMiserRuntimePreparationFailure() { return current().tokenMiserRuntimePreparationFailure; },
      set tokenMiserRuntimePreparationFailure(value) { current().tokenMiserRuntimePreparationFailure = value; },
      get tokenMiserServerCapabilities() { return current().tokenMiserServerCapabilities; },
      get tokenMiserService() { return current().tokenMiserService; },
      get tokenMiserStore() { return current().tokenMiserStore; },
      get toolOutputAlertPolicy() { return current().toolOutputAlertPolicy; },
      set toolOutputAlertPolicy(value) { current().toolOutputAlertPolicy = value; },
      turnLimitObservation: (...args: Parameters<typeof this.turnLimitObservation>) => this.turnLimitObservation(...args),
      get unsubscribers() { return current().unsubscribers; },
      updateThreadGitBranchMetadata: (...args: Parameters<typeof this.updateThreadGitBranchMetadata>) => this.updateThreadGitBranchMetadata(...args),
      usageAccountForTurn: (...args: Parameters<ThreadUsageLedger["usageAccountForTurn"]>) => this.threadUsageLedger.usageAccountForTurn(...args),
      withArchiveWorkspaceWrite: <T>(...args: Parameters<typeof this.threadArchiveCoordinator.withArchiveWorkspaceWrite<T>>) => this.threadArchiveCoordinator.withArchiveWorkspaceWrite<T>(...args),
      withCodexThreadClient: <T>(...args: Parameters<typeof this.withCodexThreadClient<T>>) => this.withCodexThreadClient<T>(...args),
      withPendingStartedThreads: (...args: Parameters<typeof this.withPendingStartedThreads>) => this.withPendingStartedThreads(...args),
      get worktreeArchiveService() { return current().worktreeArchiveService; },
      get worktreeRecoveryService() { return current().worktreeRecoveryService; },
      writeThreadLock: (...args: Parameters<typeof this.writeThreadLock>) => this.writeThreadLock(...args),
    };
  }

  // Scheduled actions need the registry before they can supply their creator.
  setScheduledThreadActionCreator(
    creator:
      | ((
          request: CreateScheduledThreadActionRequest,
          options: { id: string },
        ) => Promise<ScheduledThreadActionMutationResponse>)
      | undefined,
  ): void {
    this.createScheduledThreadActionFn = creator;
  }

  /**
   * Captured at registry construction. Action-run entries from before
   * this moment are treated as historical: their `output` is shed and
   * any "started" entries are downgraded to "failed", since the child
   * process didn't survive the parent restart.
   */
  private readonly registrySessionStartedAt = Date.now();

  private liveProfileRuntimeInstanceIds(): string[] | undefined {
    const instanceIds = new Set<string>([this.runtimeInstanceId]);
    try {
      for (const instanceId of this.resolveLiveProfileRuntimeInstanceIdsFn()) {
        const normalized = instanceId.trim();
        if (normalized) {
          instanceIds.add(normalized);
        }
      }
    } catch (error) {
      backendRegistryLog.warn("live-profile-runtime-read-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    return Array.from(instanceIds);
  }

  /**
   * Stop every running turn through its own protocol before quitting.
   *
   * Closing kills the app-server and ACP agent processes, which ends their
   * turns with no terminal event. Asked first, each backend ends its turn
   * itself: Codex answers turn/interrupt with turn/completed, status
   * interrupted, and session/cancel settles an ACP prompt with stopReason
   * cancelled. That terminal takes the normal path, so the pricing ledger,
   * transcript, queue, and every listener record an interrupted turn with
   * the backend's own end time.
   *
   * The requests go out together under one deadline. Wait for requested
   * turns to end and for pending terminal events to reach listeners, even
   * if a terminal entered before quit or already unregistered its turn.
   * A turn still running when the wait ends keeps the shutdown stamp close()
   * records. Runs once; close() waits for it too, so a close outside the quit
   * sequence still asks before it kills.
   */
  stopRunningTurnsForShutdown(
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    this.runningTurnsShutdownStop ??= this.stopRunningTurnsForShutdownOnce(
      options.timeoutMs ?? this.runningTurnShutdownStopTimeoutMs,
    ).finally(() => {
      this.runningTurnsShutdownStopSettled = true;
    });
    return this.runningTurnsShutdownStop;
  }

  private hasTurnShutdownWork(registeredTurnCount: number): boolean {
    return registeredTurnCount > 0 || this.pendingTerminalEmits.size > 0;
  }

  private async stopRunningTurnsForShutdownOnce(timeoutMs: number): Promise<void> {
    if (this.closed) {
      return;
    }
    this.stoppingRunningTurnsForShutdown = true;
    this.activeTurnBranchProbeAbort.abort();
    const keys = [...this.context.turnState.registeredTurnKeys()];
    if (!this.hasTurnShutdownWork(keys.length)) {
      return;
    }
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), Math.max(0, timeoutMs));
    });
    let unsubscribe: (() => void) | undefined;
    // No backend could be asked to stop these, so no terminal is coming.
    const unasked = new Set<string>();
    let checkEnded = (): void => {};
    const ended = new Promise<void>((resolve) => {
      checkEnded = () => {
        if (keys.every((key) =>
          unasked.has(key) || !this.context.turnState.hasRegisteredTurn(key)
        )) {
          resolve();
        }
      };
      unsubscribe = this.context.turnState.onTurnUnregistered(checkEnded);
      checkEnded();
    });
    const requests = { requested: 0, unsupported: 0, failed: 0 };
    const sent = this.requestShutdownTurnStops(keys, requests, unasked);
    // No backend could be asked, so no terminal is coming: skip the wait.
    const nothingSent = new Promise<"nothing-sent">((resolve) => {
      void sent.then(async () => {
        if (requests.requested === 0) {
          // A turn that ended on its own meanwhile still reaches listeners.
          await Promise.all([...this.pendingTerminalEmits]);
          resolve("nothing-sent");
          return;
        }
        // Only the turns a backend was asked to stop are worth waiting for.
        checkEnded();
      });
    });
    try {
      const outcome = await Promise.race([
        ended.then(async () => {
          // A turn leaves the running set before its listeners run. Let
          // messaging and the renderer see each terminal before they stop.
          await Promise.all([...this.pendingTerminalEmits]);
          return "ended" as const;
        }),
        nothingSent,
        deadline,
      ]);
      const detail = {
        durationMs: Date.now() - startedAt,
        requests: { ...requests },
        turns: keys.length,
        unanswered: keys.filter((key) => this.context.turnState.hasRegisteredTurn(key)).length,
        unasked: unasked.size,
      };
      if (outcome === "ended") {
        backendRegistryLog.info("running turns stopped for shutdown", detail);
      } else if (outcome === "nothing-sent") {
        backendRegistryLog.info("no running turn could be asked to stop", detail);
      } else {
        backendRegistryLog.warn(
          "running turns still unanswered at the shutdown deadline",
          detail,
        );
      }
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
    }
  }

  /**
   * Ask each backend to stop its turns, counting each request's outcome as it
   * answers and adding each turn no backend could be asked to `unasked`. The
   * caller's deadline, not these requests, bounds the wait.
   */
  private async requestShutdownTurnStops(
    keys: string[],
    counts: Record<"requested" | "unsupported" | "failed", number>,
    unasked: Set<string>,
  ): Promise<void> {
    const acpSessionCancels = new Map<string, Promise<boolean>>();
    // One session/cancel stops whatever the session is running. Each answer
    // is counted once, by the turn that sent it.
    const cancelAcpSession = async (
      backend: AcpBackendId,
      sessionId: string,
    ): Promise<boolean> => {
      const session = buildThreadIdentityKey(backend, sessionId);
      const pending = acpSessionCancels.get(session);
      if (pending) {
        // A failed request leaves the deadline to decide, as below.
        return await pending.catch(() => true);
      }
      const request = this.acpBackend.cancelRunningSession(backend, sessionId);
      acpSessionCancels.set(session, request);
      const sent = await request;
      counts[sent ? "requested" : "unsupported"] += 1;
      return sent;
    };
    let codexInterruptSupported: Promise<boolean> | undefined;
    await Promise.all(keys.map(async (key) => {
      const turn = parseActiveTurnKey(key);
      if (!turn) {
        counts.unsupported += 1;
        unasked.add(key);
        return;
      }
      try {
        if (turn.backend === "claude") {
          // The app is quitting, so its tasks stop with it.
          await this.claudeBackend.interruptTurn(turn, { keepTasks: false });
          counts.requested += 1;
          return;
        }
        if (isAcpBackendId(turn.backend)) {
          if (!(await cancelAcpSession(turn.backend, turn.threadId))) {
            unasked.add(key);
          }
          return;
        }
        // interruptTurn reaches an ACP review through getClientForSession,
        // which may prepare or launch a client. Cancel it in place instead.
        const review = this.managedReviewService.findReviewForParentTurn({
          backend: turn.backend,
          parentThreadId: turn.threadId,
          turnId: turn.turnId,
        });
        if (review && isAcpBackendId(review.backend)) {
          if (!(await cancelAcpSession(review.backend, review.reviewThreadId))) {
            unasked.add(key);
          }
          return;
        }
        codexInterruptSupported ??= this.codexClient
          .getInitializeResult()
          .then((result) =>
            buildCapabilities(result.methods ?? [], "codex").interruptTurn
          );
        if (!(await codexInterruptSupported)) {
          counts.unsupported += 1;
          unasked.add(key);
          return;
        }
        await this.interruptTurn(turn);
        counts.requested += 1;
      } catch (error) {
        // A turn that ended on its own rejects the request. Either way the
        // deadline decides; a turn still running keeps the shutdown stamp.
        counts.failed += 1;
        backendRegistryLog.info("shutdown turn stop request failed", {
          backend: turn.backend,
          message: error instanceof Error ? error.message : String(error),
          threadId: turn.threadId,
          turnId: turn.turnId,
        });
      }
    }));
  }

  private async cleanupStaleCodexEnvironmentRuntimes(): Promise<void> {
    const lister = this.overlayStore.listThreadOverlaysWithCodexEnvironmentRuntime;
    if (!lister) {
      // Test overlay mocks or older overlay-store implementations may
      // not expose the bulk reader. Skip cleanup silently.
      return;
    }
    const overlays = await lister.call(this.overlayStore);
    const sessionStartedAt = this.registrySessionStartedAt;
    let cleanedThreads = 0;
    let bytesShed = 0;
    let zombiesConverted = 0;
    for (const overlayHint of overlays) {
      // Run each thread's clean under the per-thread lock and re-read
      // overlay state inside it, so a concurrent runCodexEnvironmentAction
      // can't append a fresh run that we then overwrite with a stale
      // snapshot. The hint we got from `lister` is point-in-time; the
      // re-read is the source of truth.
      await this.threadDirectoryService.withCodexEnvironmentRuntimeLock(
        overlayHint.backend,
        overlayHint.threadId,
        async () => {
          const overlay = await this.overlayStore.getThreadOverlayState({
            backend: overlayHint.backend,
            threadId: overlayHint.threadId,
          });
          const runtime = overlay?.codexEnvironmentRuntime;
          if (!runtime) return;
          const runs = readCodexEnvironmentActionRuns(runtime);
          if (runs.length === 0) return;
          let changed = false;
          const nextRuns = runs.map((run) => {
        // For "started" runs, decide ownership by timestamp: anything
        // started before this registry session is a zombie (detached
        // children with piped stdio died via SIGPIPE when the prior
        // process exited). Anything started at or after sessionStartedAt
        // was kicked off by this session and must be left alone — the
        // cleanup is fire-and-forget so a fast user Run-click could
        // land a fresh entry before this iteration commits.
        //
        // Legacy-synthesised runs (from overlays written before
        // actionStartedAt existed) carry startedAt=0, which correctly
        // falls into the "before this session" bucket and gets
        // converted — fixing the regression where the renderer would
        // show a stale, undismissable "running" anchor after a parent
        // crash.
        if (run.status === "started") {
          const startedAt = run.startedAt ?? 0;
          if (startedAt >= sessionStartedAt) {
            return run;
          }
          changed = true;
          bytesShed += run.output?.length ?? 0;
          zombiesConverted += 1;
          return {
            ...run,
            status: "failed" as const,
            output: undefined,
            exitedAt: run.exitedAt ?? run.startedAt ?? sessionStartedAt,
            durationMs:
              run.durationMs ??
              Math.max(0, (run.exitedAt ?? sessionStartedAt) - startedAt),
          };
        }
        // Finished runs: shed bytes only if their latest activity
        // predates this session.
        const latestAt = Math.max(run.exitedAt ?? 0, run.startedAt ?? 0);
        if (latestAt > 0 && latestAt < sessionStartedAt && run.output) {
          changed = true;
          bytesShed += run.output.length;
          return { ...run, output: undefined };
        }
        return run;
      });
          if (!changed) return;
          cleanedThreads += 1;
          const nextRuntime: CodexThreadEnvironmentRuntime = {
            ...runtime,
            actionRuns: nextRuns,
          };
          await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
            backend: overlayHint.backend,
            threadId: overlayHint.threadId,
            codexEnvironmentRuntime: nextRuntime,
          });
        },
      );
    }
    if (cleanedThreads > 0) {
      backendRegistryLog.info("codex-environment-startup-cleanup", {
        cleanedThreads,
        zombiesConverted,
        bytesShed,
        sessionStartedAt,
      });
    }
  }

  onEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  getCodexProtocolCaptureStatus(): CodexProtocolCaptureStatus {
    return (
      this.codexProtocolCaptureSession?.getStatus() ?? {
        active: false,
        available: false,
      }
    );
  }

  async startCodexProtocolCapture(): Promise<CodexProtocolCaptureStatus> {
    if (!this.codexProtocolCaptureSession) {
      throw new Error(
        "Codex protocol capture is unavailable for this runtime.",
      );
    }
    return await this.codexProtocolCaptureSession.start();
  }

  async stopCodexProtocolCapture(): Promise<
    CodexProtocolCaptureResult | undefined
  > {
    return await this.codexProtocolCaptureSession?.stop();
  }

  setMessagingArchiveCleaner(
    cleaner: MessagingArchiveCleaner | null | undefined,
  ): void {
    return this.threadArchiveCoordinator.setMessagingArchiveCleaner(cleaner);
  }

  // Messaging needs the registry bridge before it can supply these bindings.
  setMessagingAgentToolService(
    service: MessagingAgentToolService | null | undefined,
  ): void {
    this.messagingAgentToolService = service ?? undefined;
  }

  setMessagingWorkingUpdatesSettings(settings: typeof this.messagingWorkingUpdatesSettings): void {
    this.messagingWorkingUpdatesSettings = settings;
  }

  private readonly messagingWorkingUpdatesHandler: MessagingWorkingUpdatesHandler = async (context, mode) => {
    const check: DynamicToolPermissionCheck = {
      backend: context.backend,
      threadId: context.threadId,
      turnId: context.turnId,
      category: "messaging_context",
      tool: mode === undefined ? "get_messaging_working_updates_default" : "set_messaging_working_updates_default",
    };
    const service = this.messagingAgentToolService;
    const forbidden = agentToolFailure({
      code: "forbidden",
      message: "This setting requires a verified local messaging requester with tools.messaging_profile_settings.",
    });
    try {
      if (!service?.authorizeRetainedTool || !this.isLiveDynamicToolCall(context.backend, context)) return forbidden;
      const origin = await this.readTurnCausalMessagingOrigin(context, false);
      const source = origin?.causalMessagingSource;
      if (!source || origin.causalMessagingAmbiguous) return forbidden;
      const allowed = await service.authorizeRetainedTool({
        backend: context.backend, threadId: context.threadId, turnId: context.turnId, causalMessagingSource: source,
      }, check);
      if (!allowed.allowed) return forbidden;
      const current = await this.readTurnCausalMessagingOrigin(context, false);
      if (current?.causalMessagingAmbiguous
        || current?.causalMessagingSource?.requestId !== source.requestId
        || current.causalMessagingSource.ownerId !== source.ownerId
        || current.causalMessagingSource.instanceId !== source.instanceId
        || this.messagingAgentToolService !== service
        || !this.isLiveDynamicToolCall(context.backend, context)) return forbidden;
    } catch {
      return forbidden;
    }
    const settings = this.messagingWorkingUpdatesSettings;
    if (!settings) return agentToolFailure({ code: "unsupported_operation", message: "Profile settings are unavailable on this owner." });
    try {
      const result = mode === undefined
        ? settings.readMessagingSettings().toolUpdateMode
        : await settings.setDevelopmentWorkingUpdatesDefault(mode);
      return agentToolSuccess({ scope: "local_profile", bindingTargetKind: "thread", ...result });
    } catch {
      return agentToolFailure({ code: "settings_unavailable", message: "The local profile's Working Updates default could not be saved or read." });
    }
  };

  // Automations need the registry before they can supply their inspection binding.
  setAutomationInspectionHandler(
    handler: AutomationInspectionHandler | null | undefined,
  ): void {
    this.automationInspectionHandler = handler ?? undefined;
  }

  // App management diagnostics resolve the published owner registry.
  setPwrAgentAppManagementHandler(
    handler: PwrAgentAppManagementHandler | null | undefined,
  ): void {
    this.appManagementHandler = handler ?? undefined;
  }

  private readonly appManagementCallSources = new WeakMap<object, string>();

  async canManagePwrAgent(context: import("@pwragent/shared/contracts/app-tools").PwrAgentAppManagementContext, discovery = false, acceptedOperation = false): Promise<boolean> {
    return await this.appManagementPermissionDenied(context, discovery, acceptedOperation) === null;
  }

  private async appManagementPermissionDenied(
    context: import("@pwragent/shared/contracts/app-tools").PwrAgentAppManagementContext,
    discovery = false,
    acceptedOperation = false,
  ): Promise<string | null> {
    let sourceKey: string | undefined;
    const denial = await appManagementDenial({
      allowCompleted: acceptedOperation && this.appManagementCallSources.has(context),
      isActive: (caller) => Boolean(caller.backend && caller.threadId && caller.turnId
        && this.isLiveDynamicToolCall(caller.backend, { threadId: caller.threadId, turnId: caller.turnId })),
      isToolAllowed: () => !localAgentToolRefusal("manage_pwragent"),
      isAgent: async (caller) => Boolean(caller.backend && caller.threadId
        && !(caller.backend === "codex" && this.changingCodexAgentThreadIds.has(caller.threadId))
        && (await this.overlayStore.getThreadOverlayState({ backend: caller.backend, threadId: caller.threadId }))?.agent),
      readOrigin: async (caller) => {
        if (!caller.backend || !caller.threadId) return undefined;
        const origin = await this.readTurnCausalMessagingOrigin({ backend: caller.backend, threadId: caller.threadId, turnId: caller.turnId })
          ?? this.findStartingTurnOrigin({ backend: caller.backend, threadId: caller.threadId, turnId: caller.turnId })?.origin;
        sourceKey = JSON.stringify(origin?.causalMessagingSource);
        const bound = this.appManagementCallSources.get(context);
        return bound && bound !== sourceKey ? undefined : origin;
      },
      actorDenial: async (caller, origin) => {
        if (!caller.backend || !caller.threadId) return "PwrAgent could not verify app management authorization.";
        const identity = { backend: caller.backend, threadId: caller.threadId, turnId: caller.turnId };
        const result = await this.messagingAgentToolService?.authorizeRetainedTool?.({
          ...identity, causalMessagingSource: origin.causalMessagingSource,
        }, { ...identity, category: "app_management", tool: "manage_pwragent" });
        return appManagementActorDenial(result);
      },
    }, context, discovery);
    if (denial === null && sourceKey && !discovery) this.appManagementCallSources.set(context, sourceKey);
    return denial;
  }

  getAppManagementRuntimeId(): string { return this.runtimeInstanceId; }

  async prepareAgentRestartVerification(
    context: import("@pwragent/shared/contracts/app-tools").PwrAgentAppManagementContext,
    verification: { operationId: string; expectedVersion: string; previousRuntimeId: string },
  ): Promise<() => void> {
    if (!context.backend || !context.threadId || !context.turnId || !await this.canManagePwrAgent(context, false, true)) {
      throw new Error("The restart caller is no longer authorized.");
    }
    const origin = await this.readTurnCausalMessagingOrigin({ backend: context.backend, threadId: context.threadId, turnId: context.turnId });
    if (!origin?.causalMessagingSource || origin.causalMessagingAmbiguous) throw new Error("The restart caller's identity is unavailable.");
    const entry: StoredRestartContinuation = {
      id: `app-upgrade-verification:${verification.operationId}`, kind: "queued", backend: context.backend, threadId: context.threadId,
      messageOrigin: { kind: "pwragent", systemReason: "app-restart", causalMessagingSource: origin.causalMessagingSource },
      input: [{ type: "text", text: `The authorized user requested a PwrAgent restart targeting version ${verification.expectedVersion} from runtime ${verification.previousRuntimeId}. After relaunch, call manage_pwragent status again, with current authorization, and compare currentVersion and runtimeId against that exact target and previous runtime. Report the actual result to that user. If permission is missing or revoked, report that verification could not be completed. A scheduled or handed-off request was not confirmation of installation. Do not initiate another download or restart without a new user request.` }],
      createdAt: Date.now(), queued: { origin: "scheduled" }, upgradeVerification: verification,
    };
    this.appRestartVerification = entry;
    return () => { if (this.appRestartVerification === entry) this.appRestartVerification = undefined; };
  }

  private cancelUpgradeVerification(entry: StoredRestartContinuation): StoredRestartContinuation {
    const verification = entry.upgradeVerification;
    if (!verification || verification.cancelled) return entry;
    return { ...entry, input: [...entry.input, { type: "text", text:
      "The restart request was cancelled. Resume preserved work and report cancellation, not a completed upgrade." }],
      upgradeVerification: { ...verification, cancelled: true },
    };
  }

  // Federation needs the registry before it can supply routed owner bindings.
  setPwrAgentFederationHandler(
    handler: PwrAgentFederationHandler | null | undefined,
  ): void {
    this.federationHandler = handler ?? undefined;
  }

  /**
   * Told about each thread an agent tool creates on this instance, with the
   * calling turn, so the viewers that sent that turn input can mount it.
   */
  setAgentCreatedThreadObserver(
    observer: AgentCreatedThreadObserver | null | undefined,
  ): void {
    this.agentCreatedThreadObserver = observer ?? undefined;
  }

  /**
   * The federation tools as the Star Map intake agent sees them. A factory
   * rather than a handler: the intake's options depend on the request being
   * served — who is credited for the created thread, and which staged
   * attachments belong to it — so one instance built at startup could not
   * carry either.
   */
  // Federation needs the registry before it can supply routed owner bindings.
  setStarMapIntakeFederationHandlerFactory(
    factory:
      | ((attachments: AppServerTurnInputItem[]) => PwrAgentFederationHandler)
      | null
      | undefined,
  ): void {
    this.starMapIntakeFederationHandlerFactory = factory ?? undefined;
  }

  /**
   * How an Agent tool archives, pins, or marks a local thread read: the
   * app's own paths, installed so `mutate_thread` does exactly what a
   * thread's context menu does. The archive path also ungroups remote
   * children through the federation runtime, which this registry cannot
   * reach, and the pin and seen paths publish the events every window
   * redraws from.
   */
  // The app-server service needs the registry before it can supply this owner binding.
  setAgentThreadActions(actions: AgentThreadActions | null | undefined): void {
    this.agentThreadActions = actions ?? undefined;
  }

  // The owner installs host view bindings after publishing its registry.
  setPwrAgentStarMapHandler(
    handler: PwrAgentStarMapHandler | null | undefined,
  ): void {
    this.starMapHandler = handler ?? undefined;
  }

  // The to-do owner needs the registry before it can supply its handler.
  setPwrAgentThreadTodoHandler(
    handler: PwrAgentThreadTodoHandler | null | undefined,
  ): void {
    this.threadTodoHandler = handler ?? undefined;
  }

  // Installed by the owner once the profile state database is open.
  setPwrAgentOpenAIDecisionsHandler(
    handler: PwrAgentOpenAIDecisionsHandler | null | undefined,
  ): void {
    this.openAIDecisionsHandler = handler ?? undefined;
  }

  private prepareQueuedTurnInput(entry: ThreadTurnQueueEntry): Promise<AppServerTurnInputItem[]> | undefined {
    const id = entry.messageOrigin?.kind === "pwragent" ? entry.messageOrigin.dependencyId : undefined;
    if (!id?.startsWith("checkout:")) return undefined;
    return this.prepareCheckoutWakeup?.(entry, id)
      ?? Promise.resolve([{ type: "text", text: "The resource checkout could not be verified. Do not start the dependent work." }]);
  }

  setResourceCheckoutHandler(
    handler: CheckoutToolHandler,
    prepare?: DesktopBackendRegistry["prepareCheckoutWakeup"],
  ): void {
    this.prepareCheckoutWakeup = prepare;
    this.checkoutHandler = (operation, args, context) => {
      if (!this.isLiveDynamicToolCall(context.backend, context)) throw new Error("Resource tools require an active thread turn.");
      return handler(operation, args, context);
    };
  }

  setResearchHandler(handler: ResearchAgentHandler | undefined, workerCheck?: (thread: { backend: AppServerBackendKind; threadId: string }) => boolean, enabled: () => boolean = () => false): void {
    this.researchHandler = handler;
    this.researchWorkerCheck = workerCheck;
    this.researchEnabled = enabled;
  }

  private researchOffered(surface: ResearchToolSurface): boolean {
    return researchToolsOffered(surface, { enabled: this.researchEnabled(), codexToolDiscovery: this.resolveCodexToolDiscoveryFn });
  }

  /** The handler for Codex's own dynamic tools. */
  private get advertisedResearchHandler(): ResearchAgentHandler | undefined {
    return this.researchOffered("codex") ? this.researchHandler : undefined;
  }

  /** The handler for the PwrAgent MCP server that Claude and ACP threads use. */
  private get mcpResearchHandler(): ResearchAgentHandler | undefined {
    return this.researchOffered("mcp") ? this.researchHandler : undefined;
  }

  /** A live turn of any local backend whose tool surface offers research. */
  researchContextIsLive(context: AgentToolCallContext): boolean {
    return this.researchOffered(researchToolSurface(context.backend)) && this.isLiveDynamicToolCall(context.backend, context);
  }

  async handoffResearchWorker(
    request: PwrAgentThreadOrchestrationRequest<"handoff_task">,
    onCreated: (worker: { backend: AppServerBackendKind; threadId: string }) => void,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    return await this.handleThreadOrchestrationRequest(request, onCreated);
  }

  async deliverResearchMessage(request: PwrAgentThreadOrchestrationRequest<"send_message_to_thread">): Promise<PwrAgentThreadOrchestrationResponse> {
    return await this.handleThreadOrchestrationRequest(request);
  }

  /**
   * Persists one OpenAI Decisions usage line and refreshes the calling
   * thread's pricing card. The line is its own provider and account (the
   * OpenAI API project), so no parent-turn counter or Codex subscription
   * estimate moves.
   */
  async recordOpenAIDecisionsUsageLines(lines: ThreadUsageLineRecord[]): Promise<void> {
    if (lines.length === 0 || typeof this.overlayStore.upsertThreadUsageLines !== "function") return;
    // One transaction for the whole batch.
    await this.overlayStore.upsertThreadUsageLines({ lines });
    const threads = new Map<string, { backend: AppServerBackendKind; threadId: string }>();
    for (const line of lines) {
      const threadId = line.parentThreadId ?? line.threadId;
      threads.set(JSON.stringify([line.backend, threadId]), {
        backend: line.backend as AppServerBackendKind,
        threadId,
      });
    }
    for (const thread of threads.values()) {
      await this.threadUsageLedger.emitThreadPricingUpdated(thread);
    }
  }

  /**
   * Tells the thread's windows a decisions_invoke batch moved, so its
   * Decisions tab and the strip above its composer read it again. A batch
   * lives in the owner's decisions service, not on the thread: nothing is
   * written, and it is not a sub-agent card. Its usage is already on the
   * thread as openai_decisions ledger lines.
   */
  async publishDecisionBatchUpdate(update: {
    caller: { backend: string; threadId: string };
    batchId: string;
    status: "running" | "success" | "failed" | "cancelled";
  }): Promise<void> {
    await this.emit({
      backend: update.caller.backend as AppServerBackendKind,
      notification: {
        method: "thread/decisionBatches/updated",
        params: { threadId: update.caller.threadId, batchId: update.batchId, status: update.status },
      },
    });
  }

  /**
   * Wakes a thread whose background decision batch ended, the way a task
   * monitor's result does: a queued turn that starts now when the thread is
   * idle and waits behind its turn when it is busy. A locked thread holds
   * it until unlock; a paused project holds or discards it by its policy.
   */
  async deliverDecisionBatchWakeup(params: {
    backend: string;
    threadId: string;
    batchId: string;
    text: string;
  }): Promise<void> {
    const wake = {
      backend: params.backend as AppServerBackendKind,
      threadId: params.threadId,
      input: [{ type: "text" as const, text: params.text }],
      origin: "automation" as const,
      messageOrigin: { kind: "pwragent" as const },
    };
    const queueEntryId = `decision-batch:${params.batchId}`;
    const lock = await this.readThreadLock(wake.backend, wake.threadId);
    if (lock) {
      await this.submitHeldTurn({
        ...wake,
        queueEntryId,
        holdReason: threadLockRefusalMessage(lock),
        title: "Decision batch finished",
      });
      return;
    }
    const project = this.resolvePausedThreadProject(wake);
    if (project) {
      await this.deliverProjectPausedWakeup({
        ...wake,
        project,
        queueEntryId,
        source: "other",
        summary: summarizeProjectHeldWakeup(`Decision batch finished: ${params.batchId}`),
      });
      return;
    }
    await this.submitTurn({ ...wake, queueEntryId });
  }

  /**
   * The thread's workspace directory, as handoff and review resolve it. Thread
   * to-dos capture it when a card is raised, so the card's merge or new thread
   * runs where the raising thread worked.
   */
  async resolveThreadWorkspaceCwd(
    backend: AppServerBackendKind,
    threadId: string,
  ): Promise<string | undefined> {
    const overlay = await this.overlayStore.getThreadOverlayState({ backend, threadId });
    return await this.resolveThreadEnvironmentCwd(backend, threadId, overlay);
  }

  /**
   * A backend's model catalog, awaited rather than read off a summary that
   * may still hold fallback models while discovery runs. Thread to-dos check
   * a handoff card's model against it when the card is written.
   */
  async readBackendModelOptions(
    backend: AppServerBackendKind,
  ): Promise<BackendLaunchpadOptions | undefined> {
    return this.getBackendLaunchpadOptions(backend, "thread-todo-model");
  }

  readThreadHandoffSettings(params: {
    backend: AppServerBackendKind;
    threadId: string;
    /** The live turn asking, whose mode outranks the stored one. */
    turnId?: string;
  }): Promise<HandoffSourceSettings> {
    return this.threadWorkspaceService.readThreadHandoffSettings(params);
  }

  private async resolveHandoffSourceExecutionMode(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
    overlay?: ThreadOverlayState;
  }): Promise<ThreadExecutionMode> {
    const { backend, threadId, turnId, overlay } = params;
    return (
      (backend === "codex" && turnId
        ? this.context.turnState.executionMode({ threadId: threadId, turnId: turnId })
        : undefined)
      ?? overlay?.executionMode
      ?? (backend === "codex"
        ? await this.resolveCodexThreadExecutionModeForActiveTurn(threadId)
        : isAcpBackendId(backend)
          ? this.acpBackend.getSession(backend, threadId)?.executionMode ?? "default"
          : "default")
    );
  }

  /**
   * The most access an agent tool call may ask for: the calling thread's
   * effective mode (its live Codex turn's mode first, as handoffs inherit),
   * or a lower mode the operator has queued for it. See
   * `checkAgentAccessRequest`.
   */
  async resolveAgentCallerExecutionMode(context: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
    overlay?: ThreadOverlayState;
  }): Promise<ThreadExecutionMode> {
    const overlay = context.overlay
      ?? await this.overlayStore.getThreadOverlayState({
        backend: context.backend,
        threadId: context.threadId,
      });
    const effective = await this.resolveHandoffSourceExecutionMode({
      backend: context.backend,
      threadId: context.threadId,
      turnId: context.turnId?.trim() || undefined,
      overlay,
    });
    const queued = this.getQueuedExecutionModeForThread(context)?.mode;
    return queued ? lowerThreadExecutionMode(effective, queued) : effective;
  }

  /**
   * Throws when an agent's message would run its turn above the target
   * thread's own mode. A per-turn override is neither persisted nor shown,
   * so it may keep or lower the thread's access, never raise it; raising a
   * thread's stored mode stays with mutate_thread. Runs on the thread's
   * owner, for local and federated sends alike, as the turn is submitted:
   * a queued turn is checked now, not when it is released, and again when
   * its sender replaces it. The caller's own ceiling is checked on its
   * instance before the send. Operator, messaging-app, PwrAgent and
   * operator-approved to-do deliveries pass.
   */
  private async assertAgentMessageWithinThreadAccess(params: {
    backend: AppServerBackendKind;
    threadId: string;
    executionMode?: ThreadExecutionMode;
    approvalPolicy?: string;
    sandbox?: string;
    messageOrigin?: AppServerThreadMessageOrigin;
  }): Promise<void> {
    if (params.messageOrigin?.kind !== "agent" || params.messageOrigin.operatorApproved) return;
    if (
      params.executionMode === undefined
      && params.approvalPolicy === undefined
      && params.sandbox === undefined
    ) {
      return;
    }
    const refusal = checkAgentAccessRequest(
      await this.resolveAgentCallerExecutionMode({
        backend: params.backend,
        threadId: params.threadId,
        turnId: this.getActiveTurnForThread(params)?.turnId,
      }),
      params,
      "target",
    );
    if (refusal) throw new Error(refusal.message);
  }

  /**
   * The committed handoff owns the thread's project even while a cached
   * provider summary still names its previous workspace.
   */
  async resolveThreadPrimaryDirectory(
    backend: AppServerBackendKind,
    threadId: string,
  ): Promise<LinkedDirectorySummary | undefined> {
    const overlay = await this.overlayStore.getThreadOverlayState({ backend, threadId });
    const handoff = overlay?.extraLinkedDirectories.find(isHandoffDirectory);
    if (handoff) return handoff;
    const pending = this.pendingStartedThreads.get(
      buildThreadIdentityKey(backend, threadId),
    );
    const thread = pending ?? await this.findThreadForWorkspaceHandoff({
      backend,
      callerReason: "turn-cwd",
      freshness: "last-known",
      threadId,
    });
    return thread?.linkedDirectories?.[0];
  }

  // Federation needs the registry before it can supply routed owner bindings.
  setFederatedThreadMessageHandler(
    handler: PwrAgentFederatedThreadMessageHandler | null | undefined,
  ): void {
    this.federatedThreadMessageHandler = handler ?? undefined;
  }

  /**
   * This instance's own federation id. A viewer, a card, or an agent can name
   * a thread by its owner's id while asking that owner itself, and only this
   * id says the target is local rather than a peer's.
   */
  setLocalFederationInstanceId(resolve: (() => string | undefined) | null | undefined): void {
    this.localFederationInstanceId = resolve ?? undefined;
  }

  /**
   * The instance a target names, relative to this owner: nothing for a thread
   * this instance owns, so the send stays local instead of routing to a peer
   * with its own id, which is never enrolled.
   */
  private ownerRelativeInstanceId(instanceId: string | undefined): string | undefined {
    const named = instanceId?.trim();
    if (!named) return undefined;
    let local: string | undefined;
    try {
      local = this.localFederationInstanceId?.()?.trim();
    } catch (error) {
      backendRegistryLog.warn("Could not read this instance's federation id", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return named === local ? undefined : named;
  }

  private ownerRelativeTarget<T extends { instanceId?: string; instanceLabel?: string }>(target: T): T {
    if (!target.instanceId || this.ownerRelativeInstanceId(target.instanceId)) return target;
    const { instanceId: _instanceId, instanceLabel: _instanceLabel, ...local } = target;
    return local as T;
  }

  /**
   * Naming this instance still means this instance only, so no peer is asked.
   * includeRemote false with an instanceId is refused whoever it names.
   */
  private ownerRelativeRequest<R extends { args: { instanceId?: string; includeRemote?: boolean } }>(request: R): R {
    if (request.args.includeRemote === false) return request;
    const args = this.ownerRelativeTarget(request.args);
    return args === request.args ? request : { ...request, args: { ...args, includeRemote: false } };
  }

  // Federation needs the registry before it can supply routed owner bindings.
  setFederatedThreadInspectionHandler(
    handler: PwrAgentFederatedThreadInspectionHandler | null | undefined,
  ): void {
    this.federatedThreadInspectionHandler = handler ?? undefined;
  }

  // Federation needs the registry before it can supply routed owner bindings.
  setFederatedThreadMutationHandler(
    handler: PwrAgentFederatedThreadMutationHandler | null | undefined,
  ): void {
    this.threadInspectionTools.setFederatedThreadMutationHandler(handler);
  }

  // Federation needs the registry before it can supply routed owner bindings.
  setFederatedThreadControlHandler(
    handler: PwrAgentFederatedThreadControlHandler | null | undefined,
  ): void {
    this.federatedThreadControlHandler = handler ?? undefined;
  }

  // The app-server service needs the registry before it can supply this owner binding.
  setThreadMaintenanceToolHandler(handler: ThreadMaintenanceToolHandler | undefined): void {
    this.threadInspectionTools.setThreadMaintenanceToolHandler(handler);
  }

  // The scheduled-action service needs the registry before it can supply this.
  setAgentFollowUpToolHandler(handler: import("./backend-registry-handlers").AgentFollowUpToolHandler | undefined): void {
    this.agentFollowUpToolHandler = handler;
  }

  // The app-server service needs the registry before it can supply this owner binding.
  setThreadDependencyToolHandler(
    handler: ((args: import("@pwragent/shared/contracts/thread-dependencies").ManageThreadDependenciesRequest, provenance?: Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">, actor?: string) => Promise<PwrAgentThreadInspectionResponse>) | undefined,
  ): void {
    this.threadDependencyToolHandler = handler;
  }

  // The app-server service needs the registry before it can supply this owner binding.
  setDirectoryGitStatusWriter(
    writer: DirectoryGitStatusWriter | null | undefined,
  ): void {
    this.directoryGitStatusWriter = writer ?? undefined;
  }

  // The app-server service needs the registry before it can supply this owner binding.
  setThreadPrAutoDispatchHandler(
    handler: ThreadPrAutoDispatchHandler | null | undefined,
  ): void {
    this.threadPrAutoDispatchHandler = handler ?? undefined;
  }

  private threadDependenciesPeerHandler?: (
    request: import("@pwragent/shared/contracts/thread-dependencies").ManageThreadDependenciesRequest,
    requesterInstanceId: string | undefined,
    provenance?: import("@pwragent/shared/messaging-causal-context").CausalMessagingContext,
  ) => Promise<import("@pwragent/shared/contracts/thread-dependencies").ManageThreadDependenciesResponse>;

  // The app-server service needs the registry before it can supply this owner binding.
  setThreadDependenciesPeerHandler(handler: typeof this.threadDependenciesPeerHandler): void {
    this.threadDependenciesPeerHandler = handler;
  }

  /** A peer's Continue After request about one of this owner's threads. */
  async manageThreadDependenciesForPeer(
    request: import("@pwragent/shared/contracts/thread-dependencies").ManageThreadDependenciesRequest,
    requesterInstanceId: string | undefined,
    provenance?: import("@pwragent/shared/messaging-causal-context").CausalMessagingContext,
  ): Promise<import("@pwragent/shared/contracts/thread-dependencies").ManageThreadDependenciesResponse> {
    if (!this.threadDependenciesPeerHandler) throw new Error("Continue After is not available on this instance yet.");
    return await this.threadDependenciesPeerHandler(request, requesterInstanceId, provenance);
  }

  // The app-server service needs the registry before it can supply this owner binding.
  setThreadGitWorkingStateRefreshHandler(
    handler: ThreadGitWorkingStateRefreshHandler | null | undefined,
  ): void {
    this.threadGitWorkingStateRefreshHandler = handler ?? undefined;
  }

  /**
   * Refresh a viewer-inspected thread's Git working state through the desktop
   * app-server service, which owns the thread-to-worktree map. Federation
   * uses this mediator so its backend bridge does not import the IPC module.
   */
  async refreshOwnedThreadGitWorkingState(
    request: RefreshOwnedThreadGitWorkingStateRequest,
  ): Promise<RefreshThreadGitWorkingStateResponse> {
    const handler = this.threadGitWorkingStateRefreshHandler;
    if (!handler) {
      throw new Error("Git working-state refresh service is not available yet.");
    }
    return await handler(request);
  }

  /**
   * Remember only the visibility facts needed when a later creation finishes.
   * Callers provide a complete, unfiltered snapshot; this intentionally does
   * not advance overlay reconciliation state or retain the thread history.
   */
  rememberCompleteNavigationSnapshot(snapshot: NavigationSnapshot): void {
    this.rememberNavigationVisibilityIndex(snapshot);
  }

  rememberNavigationVisibilityIndex(snapshot: {
    threads: NavigationThreadSummary[];
    directories: NavigationDirectorySummary[];
  }): void {
    // Key each thread the way `directory.threadKeys` names it. A remote row
    // pinned into a local directory is listed there under its federated key,
    // so keying everything locally made every remote pin invisible to the
    // visibility facts below — and a directory whose only pins are a peer's
    // rows would report having none.
    const threadsByKey = new Map(
      snapshot.threads.map((thread) => [
        thread.federation?.ref
          ? federatedThreadIdentityKey(thread.federation.ref)
          : buildThreadIdentityKey(thread.source, thread.id),
        thread,
      ]),
    );
    this.createdThreadVisibilityPinnedRanks = snapshot.threads
      .map((thread) => thread.pinnedRank)
      .filter((rank): rank is string => Boolean(rank));
    this.createdThreadDirectoryVisibility = new Map(
      snapshot.directories.map((directory) => {
        const directoryThreadKeys = new Set(directory.threadKeys);
        let hasPinnedTopLevelThread = false;
        const rowsByThreadKey = new Map<string, CreatedThreadVisibilityRow>();
        const rowKeysByLocalKey = new Map<string, string>();
        for (const threadKey of directory.threadKeys) {
          const thread = threadsByKey.get(threadKey);
          if (!thread) continue;
          // Resolved with the renderer's own rule so "top-level in this
          // directory" means the same thing on both sides: a parent outside
          // this directory leaves the row top-level here.
          const parentKey = resolveThreadParentKey(thread, threadsByKey);
          const nestedHere = Boolean(
            parentKey && directoryThreadKeys.has(parentKey),
          );
          rowsByThreadKey.set(threadKey, {
            backend: thread.source,
            ...(nestedHere ? { parentKey } : {}),
            pinned: Boolean(thread.pinnedRank),
            remote: Boolean(thread.federation?.ref),
            subthreadsCollapsed: thread.subthreadsCollapsed === true,
            threadId: thread.id,
          });
          rowKeysByLocalKey.set(
            buildThreadIdentityKey(thread.source, thread.id),
            threadKey,
          );
          if (thread.pinnedRank && !nestedHere) {
            hasPinnedTopLevelThread = true;
          }
        }
        return [
          directory.key,
          {
            key: directory.key,
            kind: directory.kind,
            path: directory.path,
            directoryThreadsCollapsed:
              directory.directoryThreadsCollapsed === true,
            hasPinnedTopLevelThread,
            rowsByThreadKey,
            rowKeysByLocalKey,
          },
        ];
      }),
    );
    this.navigationDirectoriesByKey = new Map(
      snapshot.directories.map((directory) => [directory.key, directory]),
    );
    // Forge Automation files each thread under the project this complete
    // scan shows it in, worktrees included.
    getProjectForgeAutomationIndex().rememberDirectories(snapshot.directories);
  }

  async publishLocalEvent(event: AgentEvent): Promise<void> {
    if (event.notification.method === "directory/threadsCollapsed/updated"
      && event.federationTarget?.scope !== "remote") {
      const params = readRecord(event.notification.params);
      const directoryKey = readOptionalString(params, ["directoryKey"]);
      const directory = directoryKey
        ? this.createdThreadDirectoryVisibility.get(directoryKey)
        : undefined;
      if (directory && typeof params?.collapsed === "boolean") {
        // Creation can finish before another complete navigation read, or
        // while a provider failure prevents one. Use the persisted disclosure
        // immediately so auto-pinning follows what the operator sees.
        directory.directoryThreadsCollapsed = params.collapsed;
      }
    }
    await this.emit(event);
  }

  tryAdmitAutomationProvider(): boolean {
    if (this.closed || this.shutdownRequested) return false;
    try {
      this.assertThreadOwnership();
      return true;
    } catch (error) {
      if (error instanceof ThreadOwnerUnavailableError) return false;
      throw error;
    }
  }

  startAutomationHeadlessTurn(
    ...args: Parameters<HeadlessAutomationTurns["startAutomationHeadlessTurn"]>
  ): ReturnType<HeadlessAutomationTurns["startAutomationHeadlessTurn"]> {
    return this.headlessAutomation.startAutomationHeadlessTurn(...args);
  }

  private publishCorrespondenceMessage(
    source: Parameters<ThreadCorrespondenceStore["message"]>[0],
    id: string,
  ): void {
    const message = this.correspondenceStore.message(source, id);
    if (message) {
      void this.emit({
        backend: source.backend,
        notification: {
          method: "item/completed",
          params: {
            threadId: source.threadId,
            ...(message.turn ? { turnId: message.turn.id } : {}),
            item: {
              id: message.id,
              type: "agentMessage",
              text: message.text,
              content: message.parts,
              origin: message.origin,
              createdAt: message.createdAt,
            },
          },
        },
      }).catch((error) => {
        backendRegistryLog.error("Could not publish cross-thread delivery state", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private updateCorrespondenceStatus(
    ...args: Parameters<ThreadCorrespondenceStore["update"]>
  ): void {
    try {
      this.correspondenceStore.update(...args);
      const [source, id] = args;
      this.publishCorrespondenceMessage(source, id);
    } catch (error) {
      // Status persistence must not turn an already-admitted backend turn into
      // a failed submission or prevent the recipient FIFO from advancing.
      backendRegistryLog.error("Could not persist cross-thread delivery state", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async emitTurnQueueLifecycle(
    event: ThreadTurnQueueLifecycleEvent,
  ): Promise<void> {
    this.trackDurableProjectHeldWakeup(event);
    const scheduledReceipt = this.durableRestartContinuations.get(event.entry.id)?.kind === "queued"
      && scheduledActionIdFromTurnQueueEntry(event.entry.id);
    if (!scheduledReceipt) this.trackRestartContinuation(event);
    if (event.type === "queued" || event.type === "held") {
      // Re-queued entries (a release that put the queue back) keep the
      // title they already have. A grouped steer that took another message
      // arrives here untitled, so the larger batch is named again.
      if (!event.entry.title) this.requestQueuedMessageTitle(event.entry);
    } else if (event.type !== "blocked") {
      this.queuedMessageTitler.forget(event.entry.id);
    }
    const origins = event.type === "queued" && event.inputUpdated
      ? event.entry.agentMessageOrigins?.slice(-1) ?? []
      : event.entry.agentMessageOrigins
      ?? [event.entry.messageOrigin];
    for (const origin of origins) {
      const source = origin?.sourceThread;
      if (source?.messageId && event.type !== "terminal") {
        this.updateCorrespondenceStatus(source, source.messageId, {
          state: event.type === "blocked" ? "held" : event.type,
          queueEntryId: event.entry.id,
          ...(event.type === "started" ? { turnId: event.turnId } : {}),
        });
      }
    }
    const baseParams = {
      threadId: event.entry.threadId,
      queueEntryId: event.entry.id,
      queueEntryCreatedAt: event.entry.createdAt,
      origin: event.entry.origin,
      ...(event.entry.messageOrigin ? { messageOrigin: event.entry.messageOrigin } : {}),
      ...(event.type === "started" ? {
        incomingWork: buildIncomingWorkSummary(event.entry, this.getCachedThreadSummary(event.entry)?.title),
      } : {}),
      automationRunId: event.entry.automationRunId,
      automationName: event.entry.automationName,
    };

    await this.emit({
      backend: event.entry.backend,
      notification: {
        method: "thread/turnQueue/updated",
        params:
          event.type === "queued"
            ? {
                ...baseParams,
                status: "queued",
                ...(event.inputUpdated ? { inputUpdated: true } : {}),
                position: event.position,
                // Windows that did not submit this entry mirror a chip
                // from the event; carry the text so they need not wait
                // for the next navigation snapshot.
                displayText: queuedTurnDisplayText(event.entry.input),
                manualReleaseRequired:
                  event.entry.manualReleaseRequired === true,
                ...queuedTurnPauseParams(event.entry),
                ...(event.entry.holdReason
                  ? { errorMessage: event.entry.holdReason }
                  : {}),
              }
            : event.type === "started"
              ? {
                  ...baseParams,
                  status: "started",
                  turnId: event.turnId,
                }
              : event.type === "failed"
                ? {
                    ...baseParams,
                    status: "failed",
                    errorMessage: event.error.message,
                  }
                : event.type === "held"
                  ? {
                      ...baseParams,
                      status: "held",
                      position: event.position,
                      displayText: queuedTurnDisplayText(event.entry.input),
                      errorMessage: event.reason,
                      manualReleaseRequired: true,
                      ...queuedTurnPauseParams(event.entry),
                    }
                  : event.type === "blocked"
                    ? {
                        ...baseParams,
                        status: "blocked",
                        errorMessage: event.error.message,
                      }
                    : event.type === "cancelled"
                      ? {
                          ...baseParams,
                          status: "cancelled",
                        }
                      : {
                          ...baseParams,
                          status: "terminal",
                          turnId: event.turnId,
                          terminalStatus: event.status,
                        },
      },
    });
    // Keep the receipt's ownership while the scheduled action records its
    // terminal queue event. A sibling scheduler can run recovery meanwhile.
    if (scheduledReceipt) this.trackRestartContinuation(event);
  }

  getLatestCodexConfigWarning(): LatestCodexConfigWarningResponse {
    return this.latestCodexConfigWarning
      ? { event: this.latestCodexConfigWarning }
      : {};
  }

  async trustCodexProject(
    request: TrustCodexProjectRequest,
  ): Promise<TrustCodexProjectResponse> {
    if (!this.codexClient.trustProject) {
      throw new Error("Codex project trust is not available.");
    }

    const result = await this.codexClient.trustProject({
      projectPath: request.projectPath,
      ...(request.configPath ? { configPath: request.configPath } : {}),
    });
    if (
      this.latestCodexConfigWarning?.notification.method === "configWarning" &&
      this.latestCodexConfigWarning.notification.params.trustedProjectPath ===
        request.projectPath &&
      (!request.configPath ||
        this.latestCodexConfigWarning.notification.params.configPath ===
          request.configPath)
    ) {
      this.latestCodexConfigWarning = undefined;
    }
    return {
      projectPath: result.projectPath,
      ...(result.configPath ? { configPath: result.configPath } : {}),
      trusted: true,
    };
  }

  getCodexAppServerRestartStatus(): CodexAppServerRestartStatus {
    return this.codexRuntimeSupervisor.getCodexAppServerRestartStatus();
  }

  onCodexAppServerRestartStatusChanged(
    listener: (status: CodexAppServerRestartStatus) => void,
  ): () => void {
    return this.codexRuntimeSupervisor.onCodexAppServerRestartStatusChanged(listener);
  }

  restartCodexAppServer(): Promise<CodexAppServerRestartResult> {
    return this.codexRuntimeSupervisor.restartCodexAppServer();
  }

  async listBackends(
    request: ListBackendsRequest = {},
    discoveryPermit?: ProviderDiscoveryPermit,
    observer?: CodexDiscoveryObserver,
  ): Promise<ListBackendsResponse> {
    if (request.refreshModels !== undefined) {
      assertProviderDiscoveryPermit(discoveryPermit, [
        "settings-user-action",
        "setup-user-action",
      ]);
    }
    if (request.refreshModels === true) {
      this.modelCatalog.invalidate();
    } else if (request.refreshModels === "codex") {
      this.modelCatalog.invalidate("codex");
    }
    if (request.refreshRateLimits) {
      await withCodexRequestActivity({ countsAsActivity: false }, () => this.refreshCodexQuotas());
    }
    const codexSummary =
      request.refreshModels === true || request.refreshModels === "codex"
        ? await this.discoverCodexBackend(discoveryPermit!, observer)
        : this.readCodexBackendSummary();
    const policy = getOwnerHostServices().runtimePolicy;
    if ((!policy || policy.enabledBackends.includes("claude")) && (request.refreshModels === true || request.refreshModels === "claude")) {
      await this.claudeBackend.discover();
    }
    const acpSummaries = !policy || policy.enabledBackends.some(isAcpBackendId) ? await this.acpBackend.describeInstalledBackends() : [];
    const summaries = [codexSummary, this.claudeBackend.summary()];
    const enabled = [...summaries, ...acpSummaries].filter(backend => !policy || policy.enabledBackends.includes(backend.kind))
      .map(backend => !policy ? backend : { ...backend,
        ...(backend.kind === "codex" && !this.codexOpenAiProviderEnabled ? { codexOpenAiProviderEnabled: false as const } : {}),
        executionModes: backend.executionModes.filter(mode => policy.executionModes.includes(mode.mode)),
      });

    const providerRefresh = this.startupProviderRefreshStatus;
    return {
      fetchedAt: Date.now(),
      backends: request.includeUnavailable ? enabled : enabled.filter((backend) => backend.available),
      ...(providerRefresh ? { providerRefresh } : {}),
    };
  }

  async invalidateProviderRuntimeSelections(params: {
    acp: boolean;
    acpRegistryIds?: readonly string[];
    codex: boolean;
  }): Promise<void> {
    if (params.acp) {
      this.acpBackend.invalidateRuntimeSelections(
        params.acpRegistryIds
        ?? PROVIDER_IDS.filter((provider) => provider !== "codex"),
      );
    }
    if (!params.codex) return;
    // A settings write is authority to stop using the obsolete executable,
    // not to discover its replacement. With nothing running, the
    // reconnectable client resolves the new command only when the next
    // permitted discovery or ordinary provider operation initializes it. A
    // running app server is replaced by a new generation from the selected
    // command, and drains what it is still running.
    this.codexBackendGeneration += 1;
    this.codexBackendSummary = undefined;
    this.planLimits.forget("codex");
    this.codexQuotaRefresh = undefined;
    this.codexQuotaRefreshAt = undefined;
    this.pendingCodexRateLimitBroadcast = undefined;
    this.codexRateLimitLastBroadcastAt = undefined;
    if (this.codexRateLimitBroadcastTimer) {
      clearTimeout(this.codexRateLimitBroadcastTimer);
      this.codexRateLimitBroadcastTimer = undefined;
    }
    this.modelCatalog.invalidate("codex");
    this.codexRuntimeSupervisor.setRuntimeRestartPending(true);
    await this.codexRuntimeSupervisor.requestCodexRuntimeSwitch();
  }

  async synchronizeProviderRuntimeSelections(): Promise<void> {
    const providers = this.configStore?.read("providers");
    if (!providers) return;
    const previous = this.providerRuntimeFingerprints;
    const next = readProviderRuntimeFingerprints(providers);
    this.providerRuntimeFingerprints = next;
    if (!previous) return;

    const changed = PROVIDER_IDS.filter(
      (provider) => previous[provider] !== next[provider],
    );
    if (changed.length === 0) {
      await this.providerRuntimeInvalidationPromise;
      return;
    }
    const acpRegistryIds = changed.filter((provider) => provider !== "codex");
    const prior = this.providerRuntimeInvalidationPromise;
    const attempt = Promise.resolve(prior).catch(() => undefined).then(
      async () => {
        await this.invalidateProviderRuntimeSelections({
          acp: acpRegistryIds.length > 0,
          acpRegistryIds,
          codex: changed.includes("codex"),
        });
      },
    );
    this.providerRuntimeInvalidationPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.providerRuntimeInvalidationPromise === attempt) {
        this.providerRuntimeInvalidationPromise = undefined;
      }
    }
  }

  /**
   * Throw if any method that reads or writes Codex thread data is
   * reached in bootstrap mode. Companion to the silent empty-return
   * in `listThreads` — that path needs to keep the sidebar quiet
   * for the focus listener, but explicit operator actions
   * (readThread, startThread, startTurn, startReview,
   * submitServerRequest, repairCodexThreadDirectoryRelationship)
   * should never reach the registry from a bootstrap window. The
   * wizard occupies the entire renderer in bootstrap mode; if any
   * of these fire, it's a code bug and we want a loud failure, not
   * silent contamination of the operator's real Codex install.
   */
  private assertNotBootstrap(method: string): void {
    if (this.isBootstrapModeFn()) {
      throw new Error(
        `backend-registry.${method} is forbidden in bootstrap mode`,
      );
    }
  }

  /** Read-only candidates for generic search. Never run navigation/list maintenance. */
  async listThreadSearchCandidates(params: {
    backend?: AppServerBackendKind;
    archived?: boolean;
    deadlineAt?: number;
  }): Promise<AppServerThreadSummary[]> {
    const checkDeadline = () => {
      if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
        throw new Error("Federated search deadline expired.");
      }
    };
    checkDeadline();
    if (this.isBootstrapModeFn()) return [];
    // Share a completed inventory across query prefixes, not one full provider
    // walk per keystroke. Use the existing event invalidation, but keep this
    // read-only projection separate from maintenance-bearing list cache entries.
    const cacheKey = JSON.stringify({
      backend: params.backend ?? "all",
      archived: params.archived === true,
      readOnlySearch: true,
    });
    const cached = this.threadListCache.get(cacheKey);
    if (cached?.threads && (cached.expiresAt ?? 0) > Date.now()) {
      return cached.threads;
    }
    // An event during the read must prevent publishing the old projection.
    // Do not share an in-flight request whose deadline belongs to another caller.
    const pending: ThreadListCacheState = { archived: params.archived === true };
    this.threadListCache.set(cacheKey, pending);
    const threads: AppServerThreadSummary[] = [];
    let providerFailed = false;
    if (
      (!params.backend || params.backend === "codex")
      && !this.isCodexBootstrapDeferredFn()
    ) {
      // Provider text filters do not cover IDs, overlay names or project paths.
      // Match the complete metadata projection on the owner, after this read.
      const codexThreads = await this.codexClient.listThreads({
        archived: params.archived,
        enrichDirectories: false,
        skipArchivedMetadataRefresh: true,
        deadlineAt: params.deadlineAt,
      }, {
        callerReason: "federation-thread-search",
        ownerId: this.threadListCacheOwnerId,
      }).catch((error) => {
        // Aggregate discovery must still reach healthy ACP providers. Explicit
        // Codex requests retain the provider error, and the deadline check below
        // still applies to the entire search rather than restarting its budget.
        if (params.backend === "codex") throw error;
        providerFailed = true;
        backendRegistryLog.warn("Codex search discovery failed; continuing aggregate search", {
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      });
      threads.push(...await this.withRetainedOwnerThreads(this.withPendingStartedThreads("codex", codexThreads, params), params));
    }
    checkDeadline();
    if (!params.backend || params.backend === "claude") {
      threads.push(...await this.claudeBackend.listThreads(params));
    }
    const acpBackends = params.backend
      ? (isAcpBackendId(params.backend) ? [params.backend] : [])
      : (await this.acpBackend.listAvailableAgents()).map((agent) => agent.backendId);
    for (const backend of acpBackends) {
      checkDeadline();
      threads.push(...this.acpBackend.listSessions(backend, { archived: params.archived })
        .map((session) => this.acpBackend.sessionToThreadSummary(session)));
    }
    const result: AppServerThreadSummary[] = [];
    for (const thread of threads) {
      checkDeadline();
      const overlay = await this.overlayStore.getThreadOverlayState({
        backend: thread.source,
        threadId: thread.id,
      });
      if (overlay?.archiveTombstonedAt !== undefined) continue;
      const cwd = resolveThreadWorkspaceCwd(thread, overlay?.extraLinkedDirectories ?? []);
      const cachedDirectory = overlay?.acpWorktreeDirectory && overlay.acpWorktreeDirectory.cwd === cwd
        ? overlay.acpWorktreeDirectory.directory
        : undefined;
      const projected = this.withObservedThreadName({
        ...thread,
        ...(thread.source === "codex" ? projectOverlayThreadTitle(thread, overlay) : {}),
        executionMode: thread.source === "claude" ? thread.executionMode ?? overlay?.executionMode : overlay?.executionMode ?? thread.executionMode,
        model: overlay?.model ?? thread.model,
        reasoningEffort: overlay?.reasoningEffort ?? thread.reasoningEffort,
        serviceTier: overlay?.serviceTier ?? thread.serviceTier,
        fastMode: overlay?.fastMode ?? thread.fastMode,
        linkedDirectories: dedupeLinkedDirectoriesByNormalizedIdentity([
          ...thread.linkedDirectories,
          ...(overlay?.extraLinkedDirectories ?? []),
          ...(cachedDirectory ? [cachedDirectory] : []),
        ]),
      });
      result.push(projected);
    }
    checkDeadline();
    if (this.threadListCache.get(cacheKey) === pending) {
      if (providerFailed) {
        // Do not hide a recovered provider behind a cached partial inventory.
        this.threadListCache.delete(cacheKey);
      } else {
        this.threadListCache.set(cacheKey, {
          archived: params.archived === true,
          threads: result,
          expiresAt: Date.now() + THREAD_SEARCH_REUSE_WINDOW_MS,
        });
      }
    }
    return result;
  }

  /** Service revocation needs complete inventory, never navigation's cached
   * or error-tolerant empty lists. A failed lookup must remain a failure. */
  async isThreadActiveForService({ backend, threadId }: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<boolean> {
    await this.subAgentStartupReconciliation;
    this.assertNotBootstrap("isThreadActiveForService");
    if (this.closed || (backend === "codex" && this.isCodexBootstrapDeferredFn())) {
      throw new Error("Thread discovery is unavailable during startup or shutdown.");
    }
    const overlay = await this.overlayStore.getThreadOverlayState({ backend, threadId });
    if (overlay?.archiveTombstonedAt !== undefined) return false;
    if (isAcpBackendId(backend)) {
      const session = this.acpBackend.getSession(backend, threadId);
      return session !== undefined && session.archivedAt === undefined;
    }
    const diagnostics = { callerReason: "federation-services" };
    const threads = await this.codexClient.listThreads({
      archived: false, enrichDirectories: false, skipArchivedMetadataRefresh: true, requireComplete: true,
    }, diagnostics);
    if (threads.some((thread) => thread.id === threadId && thread.archivedAt === undefined)) return true;
    if (!this.codexClient.listNativeSubAgentThreads) {
      throw new Error("Complete descendant discovery is unavailable.");
    }
    const descendants = await this.codexClient.listNativeSubAgentThreads({ all: true, archived: false }, diagnostics);
    return descendants.some((thread) => thread.id === threadId && thread.archivedAt === undefined);
  }

  async listThreads(params: {
    archived?: boolean;
    backend?: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    enrichDirectories?: boolean;
    filter?: string;
    forceRefresh?: boolean;
    limit?: number;
    maxPages?: number;
    skipArchivedMetadataRefresh?: boolean;
  } = {}): Promise<AppServerThreadSummary[]> {
    await this.subAgentStartupReconciliation;
    // Hard gate: the bootstrap profile MUST NEVER serve thread data,
    // regardless of what the bootstrap config.toml's onboarding
    // flags say. Concretely this guards the post-wizard dev window:
    // in dev we leave the bootstrap Electron alive (Vite dev-server
    // race — see ipc/boot-info.ts), and if the operator focuses
    // that window, `useThreadNavigation`'s focus listener triggers
    // a `getNavigationSnapshot` → listThreads call. The bootstrap
    // profile's `models.codex.profile` is unset, which means
    // "use ~/.codex/" — i.e. the operator's real Codex Desktop
    // session, with all their real threads. This check makes that
    // contamination unreachable even if `isCodexBootstrapDeferredFn`
    // gets misconfigured or the onboarding-completed flag gets
    // flipped accidentally on the bootstrap profile.
    if (this.isBootstrapModeFn()) {
      return [];
    }
    // Gate the deferred Codex probe. When the first-run wizard hasn't
    // picked a Codex profile model yet, Codex returns empty while installed
    // ACP threads remain available through the aggregate path.
    if (
      (params.backend === "codex" || params.backend === undefined) &&
      this.isCodexBootstrapDeferredFn()
    ) {
      if (params.backend === "codex") return [];
    }
    const normalizedParams = {
      ...params,
      enrichDirectories:
        params.enrichDirectories ?? shouldEnrichThreadDirectories(params.callerReason),
    };
    const cacheKey = this.buildThreadListCacheKey(normalizedParams);
    const now = Date.now();
    const cached = this.findReusableThreadListCache(normalizedParams, cacheKey, now);
    if (cached) {
      listingDiagnostics.link("registry", cached.pending ? "coalesced" : "cache-hit", cached.value, {
        caller: normalizedParams.callerReason,
        provider: normalizedParams.backend === "codex" ? "codex" : normalizedParams.backend ? "acp" : "all",
      });
      logDebug("threadListCache:hit", {
        archived: normalizedParams.archived === true,
        backend: normalizedParams.backend ?? "all",
        callerReason: normalizedParams.callerReason ?? "thread-list",
        enrichDirectories: normalizedParams.enrichDirectories,
        expiresInMs: cached.expiresInMs,
        filterPresent: Boolean(normalizedParams.filter?.trim()),
        forceRefresh: normalizedParams.forceRefresh === true,
        limit: normalizedParams.limit,
        maxPages: normalizedParams.maxPages,
        skipArchivedMetadataRefresh:
          normalizedParams.skipArchivedMetadataRefresh === true,
        pending: cached.pending,
        source: cached.source,
        threadCount: cached.threadCount,
      });
      return await cached.value;
    }

    const startedAt = Date.now();
    logDebug("threadListCache:miss", {
      archived: normalizedParams.archived === true,
      backend: normalizedParams.backend ?? "all",
      callerReason: normalizedParams.callerReason ?? "thread-list",
      enrichDirectories: normalizedParams.enrichDirectories,
      filterPresent: Boolean(normalizedParams.filter?.trim()),
      forceRefresh: normalizedParams.forceRefresh === true,
      limit: normalizedParams.limit,
      maxPages: normalizedParams.maxPages,
      skipArchivedMetadataRefresh:
        normalizedParams.skipArchivedMetadataRefresh === true,
    });
    // An event can invalidate or replace this entry while the read awaits
    // enrichment. Only the promise that still owns the key may publish it.
    const pendingState: ThreadListCacheState = { archived: normalizedParams.archived === true };
    const displayMetadataObservationSequence =
      this.reserveThreadInfoObservation();
    const execution = listingDiagnostics.trace("registry", {
      caller: normalizedParams.callerReason,
      provider: normalizedParams.backend === "codex" ? "codex" : normalizedParams.backend ? "acp" : "all",
      archived: normalizedParams.archived === true,
    }, () => this.readThreadList(normalizedParams, displayMetadataObservationSequence));
    const promise = execution
      .then((threads) => {
        if (this.threadListCache.get(cacheKey) === pendingState) {
          listingDiagnostics.remember(threads, execution);
          this.threadListCache.set(cacheKey, {
            archived: normalizedParams.archived === true,
            expiresAt: Date.now() + (this.incompleteThreadLists.has(threads)
              ? INCOMPLETE_THREAD_LIST_REUSE_WINDOW_MS
              : THREAD_LIST_REUSE_WINDOW_MS),
            threads,
          });
          logDebug("threadListCache:store", {
            archived: normalizedParams.archived === true,
            backend: normalizedParams.backend ?? "all",
            callerReason: normalizedParams.callerReason ?? "thread-list",
            durationMs: Date.now() - startedAt,
            enrichDirectories: normalizedParams.enrichDirectories,
            expiresInMs: THREAD_LIST_REUSE_WINDOW_MS,
            filterPresent: Boolean(normalizedParams.filter?.trim()),
            forceRefresh: normalizedParams.forceRefresh === true,
            limit: normalizedParams.limit,
            maxPages: normalizedParams.maxPages,
            skipArchivedMetadataRefresh:
              normalizedParams.skipArchivedMetadataRefresh === true,
            threadCount: threads.length,
          });
        }
        return threads;
      })
      .catch((error) => {
        if (this.threadListCache.get(cacheKey) === pendingState) {
          this.threadListCache.delete(cacheKey);
        }
        logDebug("threadListCache:error", {
          archived: normalizedParams.archived === true,
          backend: normalizedParams.backend ?? "all",
          callerReason: normalizedParams.callerReason ?? "thread-list",
          durationMs: Date.now() - startedAt,
          enrichDirectories: normalizedParams.enrichDirectories,
          error: error instanceof Error ? error.message : String(error),
          filterPresent: Boolean(normalizedParams.filter?.trim()),
          forceRefresh: normalizedParams.forceRefresh === true,
          limit: normalizedParams.limit,
          maxPages: normalizedParams.maxPages,
          skipArchivedMetadataRefresh:
            normalizedParams.skipArchivedMetadataRefresh === true,
        });
        throw error;
      });
    listingDiagnostics.remember(promise, execution);
    pendingState.promise = promise;
    this.threadListCache.set(cacheKey, pendingState);
    return await promise;
  }

  /**
   * Resolve provider ownership for one thread. A process-lifetime observation
   * is not proof that the provider still owns it, so only the bounded query
   * cache may satisfy this read before its forced provider refresh.
   */
  async resolveThread(params: {
    backend?: AppServerBackendKind;
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined> {
    const threadId = params.threadId.trim();
    if (!threadId) {
      return undefined;
    }
    const cached = this.findThreadListCachedSummary(
      {
        backend: params.backend,
        threadId,
      },
      { requireFresh: true, archived: false },
    );
    if (cached) {
      return cached;
    }
    const threads = await this.listThreads({
      backend: params.backend,
      archived: false,
      callerReason: "thread-id-lookup",
      enrichDirectories: false,
      forceRefresh: true,
    });
    const thread = threads.find((thread) => thread.id === threadId);
    if (thread || (params.backend && params.backend !== "codex")
      || !this.retainedOwnerThreadStorage?.list().some(row => row.id === threadId)) return thread;
    // A retained identity can be archived. Consult native archive authority
    // through the same read policy rather than treating its metadata as active.
    return (await this.listThreads({ backend: "codex", archived: true, enrichDirectories: false,
      callerReason: "thread-id-lookup", forceRefresh: true })).find(row => row.id === threadId);
  }

  /**
   * Read one already-observed thread without starting or awaiting a provider
   * thread-list walk. Hot-path consumers such as messaging admission combine
   * this volatile summary with the durable per-thread overlay instead of
   * asking navigation to rebuild every thread and directory.
   *
   * The thread-list cache is consulted first — when it is warm it holds the
   * freshest listing — and the information store answers when it is not. The
   * store matters because the cache is emptied by every mutation: without the
   * second tier, admission for a thread this process listed minutes ago falls
   * through to `resolveThread`'s forced full listing purely because something
   * unrelated invalidated the cache in between.
   *
   * This is last-observed state, not ownership proof. Consumers validating a
   * provider or federation owner must call `resolveThread`.
   */
  getCachedThreadSummary(params: {
    backend?: AppServerBackendKind;
    threadId: string;
  }): AppServerThreadSummary | undefined {
    const threadId = params.threadId.trim();
    if (!threadId) {
      return undefined;
    }
    // The store orders provider observations. Different listing variants can
    // retain older rows, so their Map insertion order cannot choose a title.
    const summary = this.threadInfoStore.findLocalSummary({
      ...(params.backend ? { backend: params.backend } : {}),
      threadId,
    }) ?? this.findThreadListCachedSummary({
      ...params,
      threadId,
    });
    // Remembered summaries survive list-cache invalidation. ACP mode changes
    // are owned by the session store; a selected-detail read must not restore
    // the old mode from a remembered row after its canonical update event.
    const session = summary && isAcpBackendId(summary.source)
      ? this.acpBackend.getSession(summary.source, threadId)
      : undefined;
    return summary && session
      ? { ...summary, acpRuntime: session.acpRuntime, executionMode: session.executionMode ?? summary.executionMode }
      : summary;
  }

  /** An explicit link hover needs display facts, without publishing provider
   * observations or invoking the maintenance-bearing thread list. */
  async readNavigationThreadLink(ref: { backend: AppServerBackendKind; threadId: string }): Promise<{
    thread: AppServerThreadSummary;
    archived: boolean;
  } | undefined> {
    this.assertNotBootstrap("readNavigationThreadLink");
    if (this.closed || (ref.backend === "codex" && this.isCodexBootstrapDeferredFn())) {
      throw new Error("Thread link discovery is unavailable.");
    }
    const readOverlays = this.overlayStore.getThreadListingOverlayStates ?? this.overlayStore.getThreadOverlayStates;
    const overlay = (await readOverlays.call(this.overlayStore, {
      backend: ref.backend, threadIds: [ref.threadId],
    }))[ref.threadId];
    if (overlay?.archiveTombstonedAt !== undefined) return undefined;

    let thread: AppServerThreadSummary | undefined;
    let archived = false;
    if (ref.backend === "codex") {
      // A current archive observation can name threads beyond the newest page.
      if (this.getThreadInfo(ref)?.archived === true) thread = this.getCachedThreadSummary(ref);
      if (!thread) {
        const readPage = this.codexClient.listArchiveCleanupThreadsPage;
        if (!readPage) throw new Error("Bounded archive discovery is unavailable.");
        const page = await readPage.call(this.codexClient, {
          archived: true, limit: 100, sortKey: "updated_at", checkpoint: async () => {},
          directoryFilter: async () => false,
        });
        thread = page.threads.find((candidate) => candidate.id === ref.threadId);
        if (!thread && page.nextCursor) throw new Error("The archived thread lookup did not cover the full inventory.");
      }
      archived = true;
    } else if (ref.backend === "claude") {
      thread = await this.claudeBackend.readThreadSummary(ref.threadId, { requireComplete: true });
      archived = thread?.archivedAt !== undefined;
    } else if (isAcpBackendId(ref.backend)) {
      const session = this.acpBackend.getSession(ref.backend, ref.threadId);
      if (session) thread = this.acpBackend.sessionToThreadSummary(session);
      archived = session?.archivedAt !== undefined;
    }
    if (!thread) return undefined;
    return {
      archived,
      thread: this.withObservedThreadName({
        ...thread,
        ...(ref.backend === "codex" ? projectOverlayThreadTitle(thread, overlay) : {}),
        executionMode: ref.backend === "claude" ? thread.executionMode ?? overlay?.executionMode : overlay?.executionMode ?? thread.executionMode,
        model: overlay?.model ?? thread.model,
        reasoningEffort: overlay?.reasoningEffort ?? thread.reasoningEffort,
      }),
    };
  }

  private findThreadListCachedSummary(
    params: {
      backend?: AppServerBackendKind;
      threadId: string;
    },
    options?: { requireFresh?: boolean; archived?: boolean },
  ): AppServerThreadSummary | undefined {
    const now = options?.requireFresh === true ? Date.now() : undefined;
    for (const state of this.threadListCache.values()) {
      if (options?.archived !== undefined && state.archived !== options.archived) {
        continue;
      }
      if (now !== undefined && (state.expiresAt ?? 0) <= now) {
        continue;
      }
      const cached = state.threads?.find(
        (thread) =>
          (!params.backend || thread.source === params.backend)
          && thread.id === params.threadId,
      );
      if (cached) {
        return cached;
      }
    }
    return undefined;
  }

  /**
   * What this process already knows about a thread. Synchronous by contract: it
   * never starts or awaits provider listing, directory enrichment, or
   * persistence, so it is safe on paths that must not wait — a quit decision, a
   * notification label, a repeating UI poll.
   *
   * `undefined` means this thread has never been observed. It never means a
   * read failed or a cache lapsed; those leave the last observation in place.
   * Callers that need directories, git state, or ordering want `resolveThread`,
   * which may reach the provider.
   */
  getThreadInfo(identity: ThreadInfoIdentity): ThreadInfo | undefined {
    return this.threadInfoStore.get(identity);
  }

  private readonly codexAgentChangeOperations = new Map<string, Promise<void>>();
  private readonly codexAttachmentDrainWaiters = new Map<string, Set<() => void>>();

  private async serializeCodexAgentChange<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.codexAgentChangeOperations.get(threadId);
    const result = (previous ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.codexAgentChangeOperations.set(threadId, settled);
    try {
      return await result;
    } finally {
      if (this.codexAgentChangeOperations.get(threadId) === settled) {
        this.codexAgentChangeOperations.delete(threadId);
      }
    }
  }

  private async notifyThreadAgentChange(backend: AppServerBackendKind, threadId: string): Promise<void> {
    this.invalidateThreadListCache(backend);
    await this.publishLocalEvent({
      backend,
      notification: { method: "thread/agent/updated", params: { threadId } },
    });
  }

  async setThreadAgent(params: {
    backend: AppServerBackendKind;
    threadId: string;
    agent: NavigationLaunchpadAgent | null;
  }): Promise<ThreadOverlayState> {
    this.assertNotBootstrap("setThreadAgent");
    if (params.backend !== "codex") {
      return await this.applyThreadAgentChange(params);
    }
    const result = await this.serializeCodexAgentChange(params.threadId, async () => {
      const current = await this.overlayStore.getThreadOverlayState(params);
      const sameAgent = (agent: typeof params.agent | undefined) =>
        (agent?.name ?? null) === (params.agent?.name ?? null)
        && (agent?.instructions ?? "") === (params.agent?.instructions ?? "");
      if (current?.queuedAgentChange && Boolean(current.agent) === Boolean(params.agent)) {
        // Selecting the applied designation cancels a pending change.
        const overlay = await this.overlayStore.setQueuedThreadAgentChange({ ...params, change: undefined });
        await this.notifyThreadAgentChange(params.backend, params.threadId);
        return overlay;
      }
      if (current && !current.queuedAgentChange && sameAgent(current.agent)) return current;
      if (this.threadHasActiveTurn(params.threadId) || this.inFlightCodexAttachments.has(params.threadId)) {
        // Negotiate now, without resuming an active thread. Unsupported runtimes
        // must not accept a request which they can never apply.
        await this.withCodexThreadClient(params.threadId, async (client) => {
          await this.requireCodexAgentRefreshTools(client, params.threadId, current);
        });
        if (current?.queuedAgentChange && !current.queuedAgentChange.error
          && sameAgent(current.queuedAgentChange.agent)) return current;
        const overlay = await this.overlayStore.setQueuedThreadAgentChange({
          ...params, change: { agent: params.agent, requestedAt: Date.now() },
        });
        await this.notifyThreadAgentChange(params.backend, params.threadId);
        return overlay;
      }
      return await this.applyThreadAgentChange(params);
    });
    // A terminal event can arrive while negotiation or persistence is awaited.
    // The serialized boundary check handles that race without waiting on itself.
    if (result.queuedAgentChange) this.scheduleQueuedAgentChange(params.threadId);
    return result;
  }

  private async requireCodexAgentRefreshTools(
    client: BackendClient,
    threadId: string,
    overlay: ThreadOverlayState | undefined,
    forVoice = false,
  ) {
    const tools = await this.buildSupportedCodexDynamicToolsRefresh({
      client,
      threadId,
      tokenMiserEnabled: this.resolveTokenMiserEnabledForOverride(overlay?.tokenMiserEnabled),
    });
    if (tools === undefined || !client.refreshThreadTools) {
      throw new Error(forVoice
        ? "Live voice cannot verify the current tool catalog for this idle thread. Select a supported PwrAgent managed Codex runtime in Settings. Restarting the app or recreating the Voice manager does not add tool-refresh support."
        : "This Codex runtime cannot refresh tools on an existing thread. Update to a supported PwrAgent managed Codex runtime, or create a new Agent thread.");
    }
    return tools;
  }

  private async applyThreadAgentChange(params: {
    backend: AppServerBackendKind;
    threadId: string;
    agent: NavigationLaunchpadAgent | null;
  }, ownsStartReservation = false): Promise<ThreadOverlayState> {
    const codex = params.backend === "codex";
    let agentReservation: object | undefined;
    if (codex) {
      agentReservation = this.context.turnState.reserveStart(params.threadId, "agent");
      this.changingCodexAgentThreadIds.add(params.threadId);
    }
    try {
      if (codex) {
        await this.flushQueuedExecutionModeIfPresent(params.threadId);
        await this.withCodexThreadClient(params.threadId, async (client) => {
          const overlay = await this.overlayStore.getThreadOverlayState(params);
          const dynamicTools = await this.requireCodexAgentRefreshTools(client, params.threadId, overlay);
          const instructions = providerDeliveredAgentInstructions(params.agent) ?? "";
          if (client.replaceThreadDeveloperInstructions
            && instructions !== (providerDeliveredAgentInstructions(overlay?.agent) ?? "")) {
            // This runs between turns, so the next turn is the first to use
            // the new text and a running turn keeps the text it started with.
            await client.replaceThreadDeveloperInstructions({
              threadId: params.threadId,
              dynamicTools,
              developerInstructions: instructions,
              updateMessage: buildCodexAgentInstructionUpdate(instructions),
            });
          } else {
            await client.refreshThreadTools!({ threadId: params.threadId, dynamicTools });
          }
        });
      }
      // Clearing the request and changing authority share one overlay commit.
      const overlay = await this.overlayStore.setThreadAgent(params);
      await this.notifyThreadAgentChange(params.backend, params.threadId);
      return overlay;
    } finally {
      if (codex) {
        this.changingCodexAgentThreadIds.delete(params.threadId);
        if (!ownsStartReservation) {
          this.context.turnState.releaseStart(params.threadId, agentReservation);
          if (!this.threadHasActiveTurn(params.threadId)
            && this.threadTurnQueue.getQueuedEntries(params).length > 0) {
            void this.threadTurnQueue.releaseThread({
              backend: params.backend, threadId: params.threadId,
              status: "agent_designation_settled",
            });
          }
        }
      }
    }
  }

  private scheduleQueuedAgentChange(threadId: string): void {
    void this.flushQueuedAgentChange(threadId).catch((error) => {
      backendRegistryLog.error("failed to settle queued Agent change", { threadId, error: String(error) });
    });
  }

  private async flushQueuedAgentChange(threadId: string, ownsStartReservation = false): Promise<void> {
    await this.serializeCodexAgentChange(threadId, async () => {
      if (this.threadHasActiveTurn(threadId, "codex", ownsStartReservation)) return;
      const params = { backend: "codex" as const, threadId };
      const overlay = await this.overlayStore.getThreadOverlayState(params);
      const change = overlay?.queuedAgentChange;
      // A failed request stays visible, but retries require an operator action.
      if (!change || change.error
        || this.threadHasActiveTurn(threadId, "codex", ownsStartReservation)) return;
      if (this.inFlightCodexAttachments.has(threadId)) {
        if (!ownsStartReservation) return;
        await new Promise<void>((resolve) => {
          const waiters = this.codexAttachmentDrainWaiters.get(threadId) ?? new Set();
          waiters.add(resolve);
          this.codexAttachmentDrainWaiters.set(threadId, waiters);
        });
      }
      try {
        await this.applyThreadAgentChange({ ...params, agent: change.agent }, ownsStartReservation);
      } catch (error) {
        await this.overlayStore.setQueuedThreadAgentChange({
          ...params, change: { ...change, error: error instanceof Error ? error.message : String(error) },
        });
        await this.notifyThreadAgentChange(params.backend, threadId);
      }
    });
  }

  readBackendComposerSettings(
    backend: AppServerBackendKind,
  ): Pick<BackendSummary, "tokenMiser" | "modelDefaults" | "modelProviderDefaults" | "codexFastAllowed"> {
    const defaults = this.resolveProviderModelDefaultsFn();
    const showBackendDefaults = backend !== "codex" || this.codexOpenAiProviderEnabled;
    return {
      modelDefaults: showBackendDefaults ? defaults[backend] : undefined,
      modelProviderDefaults: Object.fromEntries(Object.entries(defaults)
        .filter(([key]) => (showBackendDefaults && key === backend) || (backend === "codex" && key.startsWith("codex-provider:")))),
      ...(backend === "codex" ? {
        tokenMiser: {
          enabled: this.resolveTokenMiserEnabledFn(),
          defaultEnabled: this.resolveTokenMiserDefaultEnabledFn(),
        },
        codexFastAllowed: this.resolveCodexFastAllowedFn(),
      } : {}),
    };
  }

  async setThreadTokenMiser(
    request: SetThreadTokenMiserRequest,
  ): Promise<SetThreadTokenMiserResponse> {
    this.assertNotBootstrap("setThreadTokenMiser");
    const backend = request.backend ?? "codex";
    const overlay = await this.overlayStore.setThreadTokenMiser({
      backend,
      threadId: request.threadId,
      enabled: request.enabled,
    });
    this.invalidateThreadListCache(backend);
    // The same overlay notification refreshes local windows and remote viewers.
    await this.publishLocalEvent({
      backend,
      notification: {
        method: "thread/agent/updated",
        params: { threadId: request.threadId },
      },
    });
    return {
      backend,
      threadId: request.threadId,
      ...(overlay.tokenMiserEnabled !== undefined
        ? { tokenMiserEnabled: overlay.tokenMiserEnabled }
        : {}),
    };
  }

  private async readAgentMemoryContext(owner: { backend: AppServerBackendKind; threadId: string }): Promise<string | undefined> {
    try {
      const result = await this.accessAgentMemory(owner, { action: "read_index" });
      return "content" in result ? buildAgentMemoryContext(result.content) : undefined;
    } catch (error) {
      if (!(error instanceof AgentMemoryError)) backendRegistryLog.warn("Agent memory index unavailable", { backend: owner.backend, threadId: owner.threadId });
      return undefined;
    }
  }

  async accessAgentMemorySettings(request: AgentMemoryRequest): Promise<AgentMemoryResult> {
    this.assertNotBootstrap("accessAgentMemorySettings");
    const { operation } = request;
    if (!isAgentMemoryRead(operation) && !(operation && typeof operation === "object" && "revision" in operation && operation.revision)) {
      throw new AgentMemoryError("invalid_arguments", "Read the file before saving Agent memory.");
    }
    return await this.agentMemory.access(request, operation, async () => {
      await this.requireMemoryAgent(request);
      const { backend, threadId } = request;
      const exists = isAcpBackendId(backend)
        ? Boolean(this.acpBackend.getSession(backend, threadId))
        : backend === "claude"
          ? Boolean(await this.claudeBackend.readThreadSummary(threadId))
          : await this.withCodexThreadClient(threadId, async (client) =>
            Boolean(await client.readThreadSummary?.(threadId)), undefined, false);
      if (!exists) throw new AgentMemoryError("forbidden", "The owner could not find this Agent thread.");
    });
  }

  async accessAgentMemory(
    owner: { backend: AppServerBackendKind; threadId: string },
    operation: AgentMemoryArgs,
  ): Promise<AgentMemoryResult> {
    this.assertNotBootstrap("accessAgentMemory");
    return await this.agentMemory.access(owner, operation, () => this.requireMemoryAgent(owner));
  }

  private async deleteOwnedThreadAssets(owner: ThreadAssetOwner): Promise<void> {
    await this.agentMemory.purge(owner);
    await deleteThreadAssets(owner);
  }

  private async requireMemoryAgent(owner: { backend: AppServerBackendKind; threadId: string }): Promise<void> {
    if (!await this.getThreadAgentMetadata(owner)) {
      throw new AgentMemoryError("forbidden", "Memory is available only for a designated Agent thread.");
    }
  }

  async getThreadAgentMetadata(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadAgentMetadata | undefined> {
    const overlay = await this.overlayStore.getThreadOverlayState(params);
    return overlay?.agent;
  }

  private async readThreadList(
    params: {
      archived?: boolean;
      backend?: AppServerBackendKind;
      callerReason?: ThreadListCallerReason;
      enrichDirectories: boolean;
      filter?: string;
      forceRefresh?: boolean;
      limit?: number;
      maxPages?: number;
      skipArchivedMetadataRefresh?: boolean;
    },
    displayMetadataObservationSequence: number,
  ): Promise<AppServerThreadSummary[]> {
    const durableThreads = await this.readDurableStartupThreads(
      params,
      displayMetadataObservationSequence,
    );
    if (durableThreads) {
      return durableThreads;
    }
    if (params.forceRefresh && !params.skipArchivedMetadataRefresh) {
      this.threadArchiveCoordinator.invalidateArchiveCleanupReads(params.backend, undefined, false);
    }
    const diagnostics = {
      callerReason: params.callerReason ?? "thread-list",
      ownerId: this.threadListCacheOwnerId,
    };
    if (
      params.backend === "claude"
      || params.backend === "codex"
      || (params.backend && isAcpBackendId(params.backend))
    ) {
      const listed = await this.readProviderThreadList(
        params.backend,
        params,
        diagnostics,
        displayMetadataObservationSequence,
      );
      const threads = this.inheritIncompleteThreadList(
        await this.withThreadEnvironmentOptions(listed.threads),
        listed.threads,
      );
      this.rememberThreadListContexts(
        threads,
        displayMetadataObservationSequence,
        listed.enriched,
        params.archived,
      );
      this.persistProviderThreadSnapshot(params.backend, threads, params);
      return params.backend === "codex" ? await this.withRetainedOwnerThreads(threads, params) : threads;
    }

    const [codexThreads, acpThreads, claudeThreads] = await Promise.all([
      this.listThreads({
        backend: "codex",
        archived: params.archived,
        callerReason: params.callerReason,
        enrichDirectories: params.enrichDirectories,
        filter: params.filter,
        forceRefresh: params.forceRefresh,
        limit: params.limit,
        maxPages: params.maxPages,
        skipArchivedMetadataRefresh: params.skipArchivedMetadataRefresh,
      }),
      this.listAllInstalledAcpThreads(params.filter, params.archived)
        .then((threads) => this.withThreadEnvironmentOptions(threads)),
      this.listThreads({ ...params, backend: "claude" }),
    ]);

    // Only the ACP half is recorded here. The Codex half went through
    // `listThreads`, which reserved its own newer sequence and already folded
    // those rows; folding them again writes nothing the sequence guard would
    // accept, and it does so on the main thread once per navigation refresh.
    // Recording them here would also stamp rows read at the inner sequence with
    // this outer one, which is the ordering the store exists to keep honest.
    this.rememberThreadListContexts(
      acpThreads,
      displayMetadataObservationSequence,
      ACP_LISTINGS_ARE_ENRICHED,
      params.archived,
    );
    return this.inheritIncompleteThreadList(
      [...codexThreads, ...acpThreads, ...claudeThreads].sort(
        (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
      ),
      codexThreads,
    );
  }

  /**
   * Whether this listing stands in an empty Codex inventory for a failed
   * provider read. Navigation coverage asks this of the listing an index was
   * built from, so each index reports its own completeness.
   */
  isIncompleteThreadList(threads: readonly AppServerThreadSummary[]): boolean {
    return this.incompleteThreadLists.has(threads);
  }

  /**
   * A managed runtime answers without recording a provider observation, so
   * the durable selection alone would call a failed managed Codex absent.
   */
  private async hasCodexExecutable(): Promise<boolean> {
    if (this.readCodexProvider().lastKnownGood?.selectedCommand) return true;
    return await this.resolveCodexRuntimeCommandFn?.().then(() => true, () => false) ?? false;
  }

  /**
   * One backend's rows as its provider lists them, before the steps every
   * listing shares. `enriched` is whether linked directories were resolved
   * for every row.
   */
  private async readProviderThreadList(
    backend: AppServerBackendKind,
    params: {
      archived?: boolean;
      enrichDirectories: boolean;
      filter?: string;
      limit?: number;
      maxPages?: number;
      skipArchivedMetadataRefresh?: boolean;
    },
    diagnostics: { callerReason: ThreadListCallerReason; ownerId: string },
    observationSequence: number,
  ): Promise<{ threads: AppServerThreadSummary[]; enriched: boolean }> {
    if (backend === "claude") {
      const threads = await this.claudeBackend.listThreads(params);
      return {
        threads: params.archived ? threads : await this.subAgentMonitorService.withClaudeNativeSubAgents(threads),
        enriched: true,
      };
    }
    if (backend === "codex") {
      const archiveGeneration = this.threadArchiveCoordinator.archiveCleanupReadGeneration("codex");
      const listed = await this.listCodexThreads({
        archived: params.archived,
        enrichDirectories: params.enrichDirectories,
        filter: params.filter,
        limit: params.limit,
        maxPages: params.maxPages,
        skipArchivedMetadataRefresh: params.skipArchivedMetadataRefresh,
      }, diagnostics);
      const threads = this.inheritIncompleteThreadList(
        await this.filterArchivedThreadsPresentInActiveList({
          archived: params.archived,
          backend: "codex",
          diagnostics,
          filter: params.filter,
          threads: listed,
        }),
        listed,
      );
      // Listings that began before a restore cannot authorize destructive
      // cleanup, including archived reads made outside the cleanup pool.
      if ((!params.archived || !params.skipArchivedMetadataRefresh)
        && this.threadArchiveCoordinator.archiveCleanupReadGeneration("codex") === archiveGeneration) {
        this.threadArchiveCoordinator.scheduleThreadListArchiveStateCleanup({
          backend: "codex",
          observationSequence,
          archived: params.archived,
          completeInventory: !params.skipArchivedMetadataRefresh && !params.filter?.trim()
            && params.limit === undefined && params.maxPages === undefined
            && !this.isIncompleteThreadList(threads),
          threads,
        });
      }
      return { threads, enriched: params.enrichDirectories };
    }
    return {
      threads: await this.listInstalledAcpThreads(
        backend,
        params.filter,
        params.archived,
      ),
      // An ACP listing resolves linked directories for every row whatever the
      // caller asked for, so its rows are enriched even when the request was
      // not. Passing the request's flag would record them as unenriched and
      // send every `requireEnriched` read back to the provider.
      enriched: ACP_LISTINGS_ARE_ENRICHED,
    };
  }

  private inheritIncompleteThreadList(
    threads: AppServerThreadSummary[],
    source: readonly AppServerThreadSummary[],
  ): AppServerThreadSummary[] {
    if (this.incompleteThreadLists.has(source)) this.incompleteThreadLists.add(threads);
    return threads;
  }

  private async readDurableStartupThreads(
    params: {
      archived?: boolean;
      backend?: AppServerBackendKind;
      callerReason?: ThreadListCallerReason;
      enrichDirectories: boolean;
      filter?: string;
      forceRefresh?: boolean;
      limit?: number;
      maxPages?: number;
    },
    displayMetadataObservationSequence: number,
  ): Promise<AppServerThreadSummary[] | undefined> {
    if (
      this.durableStartupThreadHydrationAttempted
      || !this.providerThreadSnapshotStore
      || params.backend
      || params.archived === true
      || Boolean(params.filter?.trim())
      || params.forceRefresh === true
      || (params.callerReason !== "startup-prewarm"
        && params.callerReason !== "navigation-snapshot")
    ) {
      return undefined;
    }

    this.durableStartupThreadHydrationAttempted = true;
    const snapshots = this.providerThreadSnapshotStore.list();
    this.startupProviderRefreshStatus ??= { state: "checking" };
    // ACP metadata is local and complete. A retained provider snapshot cannot
    // resurrect a deleted session or hide one whose agent was uninstalled.
    const nativeThreads = [...snapshots.filter(snapshot => !isAcpBackendId(snapshot.backend)).flatMap((snapshot) =>
      snapshot.backend === "codex" && params.limit !== undefined
        ? snapshot.threads.filter(thread => thread.archivedAt === undefined).slice(0, params.limit)
        : snapshot.threads.filter(thread => thread.archivedAt === undefined),
    ), ...await this.readAcpThreadsForCache()];
    if (this.closed) return [];
    this.confirmRetainedNativeOwners(snapshots.flatMap(snapshot => snapshot.backend === "codex" ? [...snapshot.threads] : []));
    const codexIds = nativeThreads.filter(thread => thread.source === "codex").map(thread => thread.id);
    const readOverlays = this.overlayStore.getThreadListingOverlayStates ?? this.overlayStore.getThreadOverlayStates;
    const overlays = codexIds.length ? await readOverlays.call(this.overlayStore, { backend: "codex", threadIds: codexIds }) : {};
    // A retained inventory predates handover. It cannot contradict the latest
    // canonical acknowledgement the way a fresh provider response can.
    const titledThreads = nativeThreads.map(thread => thread.source === "codex"
      ? { ...thread, ...projectOverlayThreadTitle(thread, {
          title: overlays[thread.id]?.title, titleSource: overlays[thread.id]?.titleSource,
        }) } : thread)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    const threads = this.mergeRetainedOwnerThreads(titledThreads, params, new Set(snapshots.flatMap(snapshot =>
      snapshot.backend === "codex" ? snapshot.threads.filter(thread => thread.archivedAt !== undefined).map(thread => thread.id) : [])));
    this.rememberThreadListContexts(
      threads,
      displayMetadataObservationSequence,
      params.enrichDirectories,
      false,
    );
    backendRegistryLog.info("startup thread list hydrated from durable providers", {
      providerCount: snapshots.length,
      threadCount: threads.length,
    });
    return threads;
  }

  /**
   * Bring the Token Miser gate up at boot when the feature is on, so a resumed
   * thread is covered from its first tool call rather than from whenever a new
   * thread happens to be created. Accounting migration runs independently during
   * registry initialization, even when this feature is disabled.
   *
   * The caller must run this AFTER the one permitted startup Codex discovery
   * has published a selection. Preparation opens the app-server to read its
   * capabilities, and the registry is constructed before startup discovery is
   * even requested, so doing this from the constructor raced discovery: the
   * capability probe resolved no executable, `prepareTokenMiserRuntime` caught
   * a "Refresh Codex in Settings" error and recorded Token Miser as
   * unavailable, and nothing re-ran it for the rest of the session unless the
   * managed runtime happened to change.
   */
  async prepareTokenMiserRuntimeAtStartup(): Promise<void> {
    // Deferring this behind startup discovery means a quit can land first —
    // a managed-runtime download holds discovery open for many seconds.
    // Preparation opens the app-server, so without this guard a shutdown
    // could be followed by a fresh Codex child process and writes to a store
    // `close()` already finalized. `maybeRestartCodexForManagedRuntimeChange`
    // guards on `closed` for the same reason.
    if (this.closed) return;
    await this.threadUsageLedger.currentTokenMiserLedgerReconciliation;
    if (this.closed || !this.resolveTokenMiserEnabledFn()) return;
    await this.prepareTokenMiserRuntime();
  }

  refreshProvidersAtStartup(permit: ProviderDiscoveryPermit): Promise<void> {
    assertProviderDiscoveryPermit(permit, ["startup"]);
    if (this.shutdownRequested) return Promise.resolve();
    if (this.startupProviderRefreshPromise) {
      return this.startupProviderRefreshPromise;
    }
    if (this.startupProviderRefreshAttempted) {
      return Promise.resolve();
    }
    this.startupProviderRefreshAttempted = true;
    this.startupProviderRefreshStatus = { state: "checking" };
    const observationSequence = this.reserveThreadInfoObservation();
    this.startupProviderRefreshPromise = Promise.resolve().then(async () => {
      if (this.shutdownRequested) return;
      const startedAt = Date.now();
      const results = await Promise.allSettled([
        this.refreshCodexProviderAtStartup(permit),
        this.refreshAcpProviderThreadsAtStartup(permit),
        this.claudeBackend.discover().then(async () => ({
          backends: ["claude" as const],
          threads: await this.listThreads({ backend: "claude", forceRefresh: true }),
        })),
      ]);
      if (this.closed) {
        return;
      }
      this.startupCodexRefreshFailed = results[0]?.status === "rejected";
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        backendRegistryLog.warn("startup provider thread refresh degraded", {
          failureCount: failures.length,
          errors: failures.map((failure) =>
            failure.status === "rejected"
              ? failure.reason instanceof Error
                ? failure.reason.message
                : String(failure.reason)
              : "",
          ),
        });
      }
      backendRegistryLog.info("startup provider thread refresh completed", {
        durationMs: Date.now() - startedAt,
        failureCount: failures.length,
      });
      this.startupProviderRefreshStatus = failures.length > 0
        ? {
            state: "degraded",
            failedProviders: failures.length,
          }
        : { state: "ready" };
      await this.publishRefreshedProviderThreadsToCache(
        results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        ),
        observationSequence,
      );
      if (this.closed) return;
      await this.emit({
        backend: "codex",
        notification: {
          method: "navigation/providerThreads/refreshed",
          params: {
            failedProviders: failures.length,
          },
        },
      });
    }).finally(() => {
      this.startupProviderRefreshPromise = undefined;
    });
    return this.startupProviderRefreshPromise;
  }

  async refreshCodexAfterAuthentication(permit: ProviderDiscoveryPermit): Promise<void> {
    assertProviderDiscoveryPermit(permit, ["settings-user-action", "setup-user-action"]);
    // A failed startup refresh must finish publishing before recovery replaces
    // it. Do not join a thread-list promise admitted under rejected credentials.
    await this.startupProviderRefreshPromise;
    if (this.closed) return;
    this.invalidateThreadListCache(undefined, true);
    await this.listBackends({ refreshModels: "codex" }, permit);
    const threads = await this.listThreads({
      backend: "codex",
      callerReason: "authentication-recovery",
      enrichDirectories: false,
      forceRefresh: true,
    });
    if (this.closed) return;
    await this.publishRefreshedProviderThreadsToCache([{ backends: ["codex"], threads }]);
    if (this.closed) return;
    const failedProviders = Math.max(
      0,
      (this.startupProviderRefreshStatus?.failedProviders ?? 0)
        - (this.startupCodexRefreshFailed ? 1 : 0),
    );
    this.startupCodexRefreshFailed = false;
    this.startupProviderRefreshStatus = failedProviders > 0
      ? { state: "degraded", failedProviders }
      : { state: "ready" };
    await this.emit({
      backend: "codex",
      notification: {
        method: "navigation/providerThreads/refreshed",
        params: { failedProviders },
      },
    });
  }

  private async refreshCodexProviderAtStartup(
    permit: ProviderDiscoveryPermit,
  ): Promise<StartupProviderThreadRefresh> {
    const startedAt = performance.now();
    const threads = await this.listThreads({
      backend: "codex",
      callerReason: "startup-provider-refresh",
      enrichDirectories: false,
      forceRefresh: true,
    });
    backendRegistryLog.info("startup Codex thread refresh completed", {
      durationMs: Math.round(performance.now() - startedAt),
      threadCount: threads.length,
    });
    const discoveryStartedAt = performance.now();
    await this.discoverCodexBackend(permit);
    backendRegistryLog.info("startup Codex backend discovery completed", {
      durationMs: Math.round(performance.now() - discoveryStartedAt),
    });
    return { backends: ["codex"], threads };
  }

  private async refreshAcpProviderThreadsAtStartup(
    permit: ProviderDiscoveryPermit,
  ): Promise<StartupProviderThreadRefresh> {
    const startedAt = performance.now();
    const agents = await this.acpBackend.discoverAvailableAgents(permit);
    const discoveryDurationMs = Math.round(performance.now() - startedAt);
    const threads = (await Promise.all(
      agents.map(async (agent) => {
        return await this.listThreads({
          backend: agent.backendId,
          callerReason: "startup-provider-refresh",
          forceRefresh: true,
        });
      }),
    )).flat();
    backendRegistryLog.info("startup ACP provider refresh completed", {
      durationMs: Math.round(performance.now() - startedAt),
      discoveryDurationMs,
      providerCount: agents.length,
      threadCount: threads.length,
    });
    return {
      backends: agents.map((agent) => agent.backendId),
      threads,
    };
  }

  getStartupProviderRefreshStatus(): Readonly<StartupProviderRefreshStatus> | undefined {
    return this.startupProviderRefreshStatus;
  }

  private async publishRefreshedProviderThreadsToCache(
    refreshes: readonly StartupProviderThreadRefresh[],
    observationSequence = this.reserveThreadInfoObservation(),
  ): Promise<void> {
    if (!this.providerThreadSnapshotStore) {
      return;
    }
    const refreshedBackends = new Set(
      refreshes.flatMap((refresh) => refresh.backends),
    );
    const acpObservationSequence = this.reserveThreadInfoObservation();
    const acpThreads = await this.readAcpThreadsForCache();
    if (this.closed) return;
    const providerThreads = [
      ...refreshes.flatMap((refresh) => refresh.threads).filter(thread => !isAcpBackendId(thread.source)),
      ...this.providerThreadSnapshotStore.list()
        .filter((snapshot) => !refreshedBackends.has(snapshot.backend) && !isAcpBackendId(snapshot.backend))
        .flatMap((snapshot) => snapshot.threads),
      ...acpThreads,
    ]
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    const threads = this.mergeRetainedOwnerThreads(providerThreads, {}, new Set(this.providerThreadSnapshotStore.list()
      .flatMap(snapshot => snapshot.backend === "codex" ? snapshot.threads.filter(thread => thread.archivedAt !== undefined).map(thread => thread.id) : [])));
    // Model discovery can finish after a rename. Publishing its earlier
    // inventory is not a new provider observation; retain both its original
    // sequence and any newer acknowledged title in the cache we publish.
    const currentThreads = threads.map(thread => {
      if (isAcpBackendId(thread.source)) return thread;
      const latest = this.threadInfoStore.get({ backend: thread.source, threadId: thread.id });
      if (!latest?.title || (latest.title === thread.title && (latest.titleSource ?? thread.titleSource) === thread.titleSource)) return thread;
      return { ...thread, title: latest.title, titleSource: latest.titleSource ?? thread.titleSource };
    });
    this.invalidateThreadListCache();
    this.rememberThreadListContexts(
      currentThreads.filter(thread => !isAcpBackendId(thread.source)),
      observationSequence,
      false,
      false,
    );
    // ACP was reread from its native session store above, independently of
    // the completed provider inventories, so it owns that read's sequence.
    this.rememberThreadListContexts(acpThreads, acpObservationSequence, false, false);
    const cacheKey = this.buildThreadListCacheKey({
      callerReason: "navigation-snapshot",
      enrichDirectories: false,
    });
    this.threadListCache.set(cacheKey, {
      archived: false,
      expiresAt: Date.now() + THREAD_LIST_REUSE_WINDOW_MS,
      threads: currentThreads,
    });
  }

  private persistProviderThreadSnapshot(
    backend: AppServerBackendKind,
    threads: readonly AppServerThreadSummary[],
    params: {
      archived?: boolean;
      callerReason?: ThreadListCallerReason;
      filter?: string;
      limit?: number;
      maxPages?: number;
    },
  ): void {
    if (
      !this.providerThreadSnapshotStore
      || this.closed
      || (params.callerReason !== "startup-provider-refresh"
        && params.callerReason !== "authentication-recovery")
      || params.archived === true
      || Boolean(params.filter?.trim())
      || params.limit !== undefined
      || params.maxPages !== undefined
    ) {
      return;
    }
    this.providerThreadSnapshotStore.replace({
      backend,
      observedAt: Date.now(),
      threads: backend === "codex" ? threads : threads.map(thread => {
        // rememberThreadListContexts has already merged this read's reserved
        // observation sequence. A later native event wins over an older list.
        const latest = this.threadInfoStore.get({ backend, threadId: thread.id });
        return { ...thread,
          ...(latest?.title ? { title: latest.title, titleSource: latest.titleSource ?? thread.titleSource } : {}),
          ...(latest?.archived === true ? { archivedAt: thread.archivedAt ?? 0 } : {}),
        };
      }),
    });
  }

  private async filterArchivedThreadsPresentInActiveList(params: {
    archived?: boolean;
    backend: AppServerBackendKind;
    diagnostics: {
      callerReason: ThreadListCallerReason;
      ownerId: string;
    };
    filter?: string;
    threads: AppServerThreadSummary[];
  }): Promise<AppServerThreadSummary[]> {
    if (params.archived !== true || params.threads.length === 0) {
      return params.threads;
    }

    try {
      const activeThreads = await this.listCodexThreads({
        archived: false,
        enrichDirectories: false,
        filter: params.filter,
      }, {
        ...params.diagnostics,
        callerReason: `${params.diagnostics.callerReason}:active-archive-filter`,
      });
      const activeThreadIds = new Set(activeThreads.map((thread) => thread.id));
      const filteredThreads = params.threads.filter(
        (thread) => !activeThreadIds.has(thread.id),
      );
      const filteredCount = params.threads.length - filteredThreads.length;
      if (filteredCount > 0) {
        backendRegistryLog.info("archived thread list filtered active duplicates", {
          backend: params.backend,
          filteredCount,
          threadIds: params.threads
            .filter((thread) => activeThreadIds.has(thread.id))
            .slice(0, 10)
            .map((thread) => thread.id),
        });
      }
      return filteredThreads;
    } catch (error) {
      backendRegistryLog.warn("archived thread active-state filter failed", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
      });
      return params.threads;
    }
  }

  /**
   * Repository key an ACP cwd's commands are cached under.
   *
   * A worktree resolves to the checkout it was cut from, so a launchpad sitting
   * on `/repo` and a born thread running in `/worktrees/ab12/repo` share one
   * cache row — commands come from the repo's command files, not from the
   * worktree. `resolveWorktreeRepositoryDirectory` is filesystem-only and never
   * spawns git; a plain checkout (or an unreadable path) resolves to itself.
   *
   * A `workMode: "worktree"` draft is not a special case here: the draft's
   * `directoryPath` is the *source* checkout it will be cut from, and the
   * worktree itself is only created later by `prepareLaunchpadWorkspace`. So
   * the path handed to us already exists and already is the base repo (or a
   * worktree of it, which resolves back to the base).
   */
  private async resolveAcpCommandRepositoryPath(
    cwd: string,
  ): Promise<string | undefined> {
    const trimmed = cwd.trim();
    if (!trimmed) {
      return undefined;
    }

    const resolved = path.resolve(trimmed);
    try {
      const directory = await this.acpWorktreeRepositoryResolver(resolved);
      if (directory?.path) {
        return directory.path;
      }
    } catch (error) {
      backendRegistryLog.warn("ACP command cache repository resolution failed", {
        cwd: resolved,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return toForwardSlashes(resolved);
  }

  private async resolveAcpCommandRepositoryPaths(
    cwds: Array<string | undefined>,
  ): Promise<string[]> {
    const resolved: string[] = [];
    for (const cwd of cwds) {
      if (!cwd?.trim()) {
        continue;
      }
      const repositoryPath = await this.resolveAcpCommandRepositoryPath(cwd);
      if (repositoryPath && !resolved.includes(repositoryPath)) {
        resolved.push(repositoryPath);
      }
    }
    return resolved;
  }

  /**
   * Serve an ACP agent's slash commands for a request with no session behind
   * it. Cache first (free, and kept fresh by every real session's
   * write-through); a probe only runs when this agent has never reported
   * commands for this repo.
   *
   * An empty stored row counts as *no answer*, not as "this agent has no
   * commands". Treating it as an answer is what turned one slow probe into a
   * permanently empty `/` menu: the row suppressed every later probe, and only
   * a real session in that repo could dislodge it. Nothing writes empty rows
   * any more, and ignoring the ones already on disk lets an affected profile
   * heal on the next request.
   */
  private async resolveAcpAvailableCommands(params: {
    backend: AcpBackendId;
    cwds: Array<string | undefined>;
  }): Promise<AppServerAvailableCommandSummary[]> {
    const repositoryPaths = await this.resolveAcpCommandRepositoryPaths(
      params.cwds,
    );
    for (const repositoryPath of repositoryPaths) {
      const cached = this.acpAvailableCommandsStore?.get(
        params.backend,
        repositoryPath,
      );
      if (cached && cached.commands.length > 0) {
        return cached.commands;
      }
    }

    const probeTarget = repositoryPaths[0];
    if (!probeTarget) {
      return [];
    }
    return await this.probeAcpAvailableCommands({
      backend: params.backend,
      repositoryPath: probeTarget,
    });
  }

  /**
   * Learn an agent's commands for a repo by opening a throwaway session purely
   * to receive its `available_commands_update`.
   *
   * Deduped per (agent, repo) by an in-flight promise, and backed off after an
   * empty result, so a burst of composer keystrokes can never turn into a burst
   * of agent process spawns. The renderer's own request dedupe
   * (`useThreadSkills`) is the first line of defense; this is the second, and
   * the one that holds across windows.
   */
  private async probeAcpAvailableCommands(params: {
    backend: AcpBackendId;
    repositoryPath: string;
  }): Promise<AppServerAvailableCommandSummary[]> {
    const probeKey = `${params.backend}:${params.repositoryPath}`;
    const inFlight = this.acpAvailableCommandProbes.get(probeKey);
    if (inFlight) {
      return await inFlight;
    }

    const cooldownUntil =
      this.acpAvailableCommandProbeCooldowns.get(probeKey) ?? 0;
    if (this.closed || Date.now() < cooldownUntil) {
      return [];
    }

    // One clock for the whole attempt. `runAcpAvailableCommandProbe` spends
    // what it needs on the spawn and hands the remainder to the notification
    // wait; the race below is the hard stop for the stages that can hang
    // before the wait is ever reached.
    const deadlineAt = Date.now() + this.acpAvailableCommandProbeBudgetMs;
    const attempt = this.runAcpAvailableCommandProbe({ ...params, deadlineAt });
    const probe = this.withAcpAvailableCommandProbeDeadline(params, attempt);
    this.acpAvailableCommandProbes.set(probeKey, probe);
    // Cleanup follows the attempt rather than the deadline. Clearing the entry
    // when the deadline fires would let the next request start a second probe
    // alongside the stuck one; leaving it means later requests resolve
    // instantly from the already-settled deadline, and the pair only reopens
    // once the attempt itself finally gives up.
    void attempt.finally(() => {
      this.acpAvailableCommandProbes.delete(probeKey);
    });
    return await probe;
  }

  /**
   * Bound a probe attempt so a wedged agent cannot hold `listSkills` open.
   *
   * The attempt is not cancelled — ACP has no way to abandon an in-flight
   * `session/new`, and there is nothing to clean up: the session is hidden, so
   * a late arrival costs nothing and still writes its commands through to the
   * cache for the next request.
   */
  private async withAcpAvailableCommandProbeDeadline(
    params: { backend: AcpBackendId; repositoryPath: string },
    attempt: Promise<AppServerAvailableCommandSummary[]>,
  ): Promise<AppServerAvailableCommandSummary[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<AppServerAvailableCommandSummary[]>(
      (resolve) => {
        timer = setTimeout(() => {
          backendRegistryLog.warn("ACP available-command probe exceeded budget", {
            backend: params.backend,
            budgetMs: this.acpAvailableCommandProbeBudgetMs,
            repositoryPath: params.repositoryPath,
          });
          this.acpAvailableCommandProbeCooldowns.set(
            `${params.backend}:${params.repositoryPath}`,
            Date.now() + ACP_AVAILABLE_COMMAND_PROBE_COOLDOWN_MS,
          );
          resolve([]);
        }, this.acpAvailableCommandProbeBudgetMs);
        timer.unref?.();
      },
    );

    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async runAcpAvailableCommandProbe(params: {
    backend: AcpBackendId;
    deadlineAt: number;
    repositoryPath: string;
  }): Promise<AppServerAvailableCommandSummary[]> {
    const probeKey = `${params.backend}:${params.repositoryPath}`;
    try {
      const client = await this.acpBackend.getClient(params.backend);
      const session = await this.withArchiveWorkspaceWrite([params.repositoryPath], async () => await client.startSession({
        cwd: params.repositoryPath,
        executionMode: "default",
        // Hidden keeps the throwaway session out of every thread list, exactly
        // like the managed review child. `mcpServers: "none"` keeps the probe
        // from standing up the agent-tool MCP surface for a session that will
        // never take a prompt.
        hidden: true,
        mcpServers: "none",
        title: "Command discovery",
      }));
      const commands = await this.awaitAcpAvailableCommands({
        backend: params.backend,
        deadlineAt: params.deadlineAt,
        threadId: session.sessionId,
      });
      if (commands.length > 0) {
        // Only a positive observation is durable. The write-through for the
        // same notification normally already did this, but recording it here
        // keeps the probe self-contained rather than dependent on that
        // ordering. An empty result is never persisted — a probe that came up
        // empty because the agent was slow is indistinguishable from one whose
        // agent has no commands, and guessing wrong costs the operator a
        // permanently empty menu. The in-memory cooldown below is what keeps
        // an empty result from re-spawning the agent on the next keystroke.
        this.acpAvailableCommandsStore?.upsert({
          backendId: params.backend,
          repositoryPath: params.repositoryPath,
          commands,
          observedAt: Date.now(),
        });
        return commands;
      }
    } catch (error) {
      backendRegistryLog.warn("ACP available-command probe failed", {
        backend: params.backend,
        repositoryPath: params.repositoryPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.acpAvailableCommandProbeCooldowns.set(
      probeKey,
      Date.now() + ACP_AVAILABLE_COMMAND_PROBE_COOLDOWN_MS,
    );
    return [];
  }

  /**
   * Wait for the agent to advertise, for whatever is left of the probe budget
   * after the spawn. A fast agent gets nearly all of it; a slow one still
   * cannot push the caller past the deadline.
   */
  private async awaitAcpAvailableCommands(params: {
    backend: AcpBackendId;
    deadlineAt: number;
    threadId: string;
  }): Promise<AppServerAvailableCommandSummary[]> {
    const waiterKey = `${params.backend}:${params.threadId}`;
    const remainingMs = Math.max(0, params.deadlineAt - Date.now());
    return await new Promise<AppServerAvailableCommandSummary[]>((resolve) => {
      let settled = false;
      const settle = (
        commands: AppServerAvailableCommandSummary[],
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const waiters = this.acpAvailableCommandWaiters.get(waiterKey);
        waiters?.delete(settle);
        if (waiters && waiters.size === 0) {
          this.acpAvailableCommandWaiters.delete(waiterKey);
        }
        resolve(commands);
      };
      const timer = setTimeout(() => settle([]), remainingMs);
      timer.unref?.();

      const waiters =
        this.acpAvailableCommandWaiters.get(waiterKey) ?? new Set();
      waiters.add(settle);
      this.acpAvailableCommandWaiters.set(waiterKey, waiters);

      // The update can land while `session/new` is still resolving, in which
      // case it is already in the session store and no notification is coming.
      const observed = this.acpBackend.getSession(
        params.backend,
        params.threadId,
      )?.availableCommands;
      if (observed?.length) {
        settle(observed);
      }
    });
  }

  /**
   * Write-through for every ACP session that reports its slash commands, so a
   * later launchpad draft in the same repo can be answered without a session.
   * Fire-and-forget: a cache miss costs a probe, never a failed request.
   */
  private rememberAcpAvailableCommands(event: AgentEvent): void {
    if (
      event.notification.method !== "thread/availableCommands/updated"
      || !isAcpBackendId(event.backend)
    ) {
      return;
    }

    const backend = event.backend;
    const { commands, threadId } = event.notification.params;
    // An empty update is treated as "no news", not as "this repo has no
    // commands": agents emit one during session setup before their command
    // registry is populated, and letting that clobber a good cache would empty
    // the launchpad menu until the next real session. The probe is the only
    // path that records an empty list, and only after waiting one out.
    if (!Array.isArray(commands) || commands.length === 0) {
      return;
    }

    for (const waiter of [
      ...(this.acpAvailableCommandWaiters.get(`${backend}:${threadId}`) ?? []),
    ]) {
      waiter(commands);
    }

    const cwd = this.acpBackend.getSession(backend, threadId)?.cwd;
    if (!cwd) {
      return;
    }

    void this.resolveAcpCommandRepositoryPath(cwd)
      .then((repositoryPath) => {
        if (!repositoryPath) {
          return;
        }
        this.acpAvailableCommandsStore?.upsert({
          backendId: backend,
          repositoryPath,
          commands,
          observedAt: Date.now(),
        });
      })
      .catch((error) => {
        backendRegistryLog.warn("ACP available-command cache write failed", {
          backend,
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async listSkills(params: {
    backend?: AppServerBackendKind;
    cwd?: string;
    cwds?: string[];
    threadId?: string;
  } = {}): Promise<Pick<AppServerListSkillsResponse, "data">> {
    const backend = params.backend ?? "codex";
    if (isAcpBackendId(backend)) {
      const session = params.threadId
        ? this.acpBackend.getSession(backend, params.threadId)
        : undefined;
      const sessionCommands = session?.availableCommands ?? [];
      if (sessionCommands.length > 0) {
        return { data: [{ commands: sessionCommands, skills: [] }] };
      }

      // No live session has reported commands for this request — either it is a
      // launchpad draft (no thread id at all) or a session that has not yet
      // advertised. Fall back to what the repo last told us, and probe for it
      // when we have never seen this repo/agent pair.
      const commands = await this.resolveAcpAvailableCommands({
        backend,
        cwds: [session?.cwd, params.cwd, ...(params.cwds ?? [])],
      });
      return { data: [{ commands, skills: [] }] };
    }

    if (backend === "claude") {
      const commands = await this.claudeBackend.listCommands({
        threadId: params.threadId,
        cwd: params.cwd ?? params.cwds?.[0],
      });
      return { data: commands.length > 0 ? [{ commands, skills: [] }] : [] };
    }
    const client = this.getClient(backend);
    const data = await client.listSkills({
      cwd: params.cwd,
      cwds: params.cwds,
    });
    const commands = backendMethodCommands(
      backend,
      (await client.getInitializeResult()).methods ?? [],
    );

    if (commands.length === 0) {
      return { data };
    }

    if (data.length === 0) {
      return {
        data: [
          {
            commands,
            skills: [],
          },
        ],
      };
    }

    return {
      data: data.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              commands: mergeCommandSummaries(entry.commands, commands),
            }
          : entry,
      ),
    };
  }

  private async listAllInstalledAcpThreads(
    filter?: string,
    archived?: boolean,
  ): Promise<AppServerThreadSummary[]> {
    const inventory = this.acpBackend.listInventorySessions({ archived });
    if (inventory) {
      const threadLists = await Promise.all(inventory.map(({ backendId, sessions }) =>
        this.enrichAcpThreadList(backendId, sessions, filter),
      ));
      return threadLists.flat();
    }
    const sessions = this.acpBackend.listAllSessions();
    const backends = sessions
      ? [...new Set(sessions.map(session => session.backendId))]
      : (await this.acpBackend.listAvailableAgents()).map(agent => agent.backendId);
    const threadLists = await Promise.all(
      backends.map((backend) =>
        this.listInstalledAcpThreads(backend, filter, archived),
      ),
    );
    return threadLists.flat();
  }

  private async readAcpThreadsForCache(): Promise<AppServerThreadSummary[]> {
    const enriched = await this.withThreadEnvironmentOptions(await this.listAllInstalledAcpThreads());
    if (this.closed) return [];
    const byIdentity = new Map(enriched.map(thread => [buildThreadIdentityKey(thread.source, thread.id), thread]));
    // Directory/environment IO may overlap deletion, hiding or a native rename.
    // Only current native members and facts may enter the navigation cache.
    const sessions = this.acpBackend.listAllSessions() ?? enriched.flatMap(thread => {
      const session = isAcpBackendId(thread.source) ? this.acpBackend.getSession(thread.source, thread.id) : undefined;
      return session ? [session] : [];
    });
    return sessions.filter(session => !session.hidden && session.archivedAt === undefined).map(session => {
      const native = this.acpBackend.sessionToThreadSummary(session);
      const previous = byIdentity.get(buildThreadIdentityKey(session.backendId, session.sessionId));
      return previous && previous.projectKey === native.projectKey ? { ...native,
        linkedDirectories: previous.linkedDirectories, codexEnvironmentOptions: previous.codexEnvironmentOptions } : native;
    });
  }

  /**
   * Attaches the environments defined in each thread's workspace. Every
   * provider listing passes through here, whatever its backend: when each
   * backend's list did this itself, the Claude list never did, and its
   * threads showed an environment's Run chip with no Environment picker.
   */
  private async withThreadEnvironmentOptions(
    threads: AppServerThreadSummary[],
  ): Promise<Array<AppServerThreadSummary & { codexEnvironmentOptions?: CodexEnvironmentOption[] }>> {
    if (threads.length === 0) return threads;
    const readOverlays = this.overlayStore.getThreadListingOverlayStates
      ?? this.overlayStore.getThreadOverlayStates;
    const threadIdsByBackend = new Map<AppServerBackendKind, string[]>();
    for (const thread of threads) {
      const ids = threadIdsByBackend.get(thread.source) ?? [];
      ids.push(thread.id);
      threadIdsByBackend.set(thread.source, ids);
    }
    const overlaysByBackend = new Map(await Promise.all(
      [...threadIdsByBackend].map(async ([backend, threadIds]) => [
        backend,
        await readOverlays.call(this.overlayStore, { backend, threadIds }),
      ] as const),
    ));
    // Threads in one checkout share its environment files; read them once.
    const optionsByCwd = new Map<string, Promise<CodexEnvironmentOption[]>>();
    return await Promise.all(
      threads.map(async (thread) => {
        const cwd = resolveThreadWorkspaceCwd(
          thread,
          overlaysByBackend.get(thread.source)?.[thread.id]?.extraLinkedDirectories ?? [],
        );
        if (!cwd) return { ...thread, codexEnvironmentOptions: [] };
        let options = optionsByCwd.get(cwd);
        if (!options) {
          options = listCodexEnvironmentOptions(cwd).catch(() => []);
          optionsByCwd.set(cwd, options);
        }
        return { ...thread, codexEnvironmentOptions: await options };
      }),
    );
  }

  private async listInstalledAcpThreads(
    backendId: AppServerBackendKind,
    filter?: string,
    archived?: boolean,
  ): Promise<AppServerThreadSummary[]> {
    if (!isAcpBackendId(backendId)) {
      return [];
    }
    return this.enrichAcpThreadList(backendId, this.acpBackend.listSessions(backendId, { archived }), filter);
  }

  private async enrichAcpThreadList(
    backendId: AcpBackendId,
    sessions: AcpSessionMetadata[],
    filter?: string,
  ): Promise<AppServerThreadSummary[]> {
    const normalizedFilter = filter?.trim().toLowerCase();
    const threads = sessions.map((session) => this.acpBackend.sessionToThreadSummary(session));
    const enrichedThreads = await Promise.all(
      threads.map(async (thread) => {
        const overlay = await this.overlayStore.getThreadOverlayState({
          backend: backendId,
          threadId: thread.id,
        });
        const executionMode =
          this.latestAppliedExecutionModeFromOverlay(overlay) ??
          thread.executionMode;
        const cwd = resolveThreadWorkspaceCwd(
          thread,
          overlay?.extraLinkedDirectories ?? [],
        );
        const linkedDirectories = await this.resolveAcpLinkedDirectories(
          thread,
          cwd,
          overlay,
          backendId,
        );
        return {
          ...thread,
          executionMode,
          linkedDirectories: dedupeLinkedDirectoriesByNormalizedIdentity(linkedDirectories),
        };
      }),
    );
    return enrichedThreads.filter(
      (thread) =>
        !normalizedFilter ||
        thread.title.toLowerCase().includes(normalizedFilter) ||
        thread.id.toLowerCase().includes(normalizedFilter),
    );
  }

  /**
   * ACP sessions only know their working directory. When that cwd is a
   * tool-managed worktree (`.codex/.../worktrees/...`, `.pwragent/.../worktrees/...`,
   * `<repo>/.worktrees/...`), resolve the underlying repository checkout by
   * following the worktree's `.git` link (filesystem only — this NEVER spawns
   * git) so the thread's linked directory is repo-rooted (`path` = repo,
   * `worktreePath` = cwd). That makes ACP worktree threads group under the same
   * directory row as their repo — matching Codex — instead of each worktree
   * getting its own folder.
   *
   * The repo↔worktree mapping is immutable for a given worktree path, so a
   * successful resolution is cached durably on the thread overlay
   * (`acpWorktreeDirectory`, keyed by cwd) and reused on every later list read
   * without touching the filesystem again. The resolver therefore runs at most
   * once per worktree thread, not once per refresh.
   *
   * Falls back to the session's own linked directories when the cwd is a plain
   * local checkout (already repo-rooted), is not a managed worktree, or resolves
   * to nothing (e.g. the worktree was deleted). A miss is deliberately left
   * uncached so a transient failure is retried cheaply, and a vanished
   * worktree's thread stays on its row rather than dropping to "unlinked".
   */
  private async resolveAcpLinkedDirectories(
    thread: AppServerThreadSummary,
    cwd: string | undefined,
    overlay: ThreadOverlayState | undefined,
    backendId: AppServerBackendKind,
  ): Promise<AppServerThreadSummary["linkedDirectories"]> {
    if (!cwd || !isLikelyToolManagedWorktreePath(cwd)) {
      return thread.linkedDirectories;
    }

    // Reuse the durably-cached resolution while the session cwd is unchanged.
    const cached = overlay?.acpWorktreeDirectory;
    if (cached && cached.cwd === cwd) {
      return [cached.directory];
    }

    try {
      const directory = await this.acpWorktreeRepositoryResolver(cwd);
      if (directory) {
        await this.overlayStore.setAcpWorktreeDirectory({
          backend: backendId,
          threadId: thread.id,
          cwd,
          directory,
        });
        return [directory];
      }
    } catch (error) {
      backendRegistryLog.warn("ACP worktree repository resolution failed", {
        threadId: thread.id,
        backend: thread.source,
        cwd,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return thread.linkedDirectories;
  }

  private async readAcpThread(
    request: AppServerReadThreadRequest,
    backend: AcpBackendId,
  ): Promise<AppServerReadThreadResponse> {
    const session = this.acpBackend.getSession(backend, request.threadId);
    if (!session) {
      throw new Error(`ACP session not found: ${request.threadId}`);
    }

    const replay = pageNormalizedReplay(
      await this.acpBackend.readReplay(backend, request.threadId),
      { ...request, backend },
    );
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend,
      threadId: request.threadId,
    });
    // A managed review runs in a hidden child session, so its transcript
    // entries and its usage line live in this thread's overlay rather than in
    // the provider's rollout. Splice them back in on the same terms as the
    // Codex path.
    //
    // Only monitor-scope usage is merged here. Turn-scope usage is persisted
    // for ACP threads too, but merging it would also apply the Codex
    // supersede rule that drops each turn's "Latest request usage" line — a
    // transcript change for every ACP thread, well beyond managed review.
    // Replaying turn-scope usage for ACP is worth doing deliberately, with
    // its own tests; it is not this change.
    //
    // Usage merges into an older pagination page too. It is turn-anchored, so
    // a page only ever receives usage for turns it actually carries, and the
    // reader sees each row beside its own turn as history loads.
    //
    // Managed review entries stay on the live page only. They originate a
    // turn rather than annotate one, so their turn id need not appear in the
    // provider rollout at all and they have no anchor to page against.
    const appendTranscriptOverlays = request.includeTurns !== false;
    const replayWithTranscriptOverlays = appendTranscriptOverlays
      ? mergeTurnAnchoredUsageActivities({
          replay: request.before
            ? replay
            : mergeManagedReviewEntries({
                replay,
                entries: overlay?.managedReviewEntries,
              }),
          activities: (await this.threadUsageLedger.readThreadUsageActivities(backend, [request.threadId]))[request.threadId]?.filter(
            (activity) => usageActivityScope(activity) === "monitor",
          ),
        })
      : replay;
    const messageIds = [
      ...replayWithTranscriptOverlays.entries.flatMap((entry) =>
        entry.type === "message" && entry.role === "user" ? [entry.id] : [],
      ),
      ...replayWithTranscriptOverlays.messages.flatMap((message) =>
        message.role === "user" ? [message.id] : [],
      ),
    ];
    const persistedMessageOrigins =
      typeof this.overlayStore.readThreadMessageOrigins === "function"
        ? await this.overlayStore.readThreadMessageOrigins({
            backend,
            threadId: request.threadId,
            messageIds,
          })
        : {};
    // Review and task-monitor cards only. Gate cards are most of a busy
    // thread's history and neither helper below can match one.
    const transcriptCards = await this.overlayStore.listThreadSubAgents({
      backend,
      threadId: request.threadId,
      excludeTokenMiser: true,
    });
    const messageOrigins = inferLegacyTaskMonitorMessageOrigins({
      origins: persistedMessageOrigins,
      replay: replayWithTranscriptOverlays,
      subAgents: transcriptCards,
    });
    const replayWithMessageOrigins = mergeThreadMessageOrigins(
      replayWithTranscriptOverlays,
      messageOrigins,
    );
    const replayWithReviewMetadata = attachReviewEntryMetadata({
      replay: replayWithMessageOrigins,
      subAgents: transcriptCards,
    });
    const includeAccounting = request.includeAccounting !== false;
    const pricing = includeAccounting
      ? await this.threadUsageLedger.readThreadPricingWithLiveTokenMiser({
          backend,
          threadId: request.threadId,
        })
      : undefined;
    // Tool accounting is durable, but the response replaces the renderer's
    // whole session snapshot — so omitting it here does not just leave the
    // field stale, it erases whatever the live
    // `thread/toolAccounting/updated` events had already patched in. On an
    // ACP thread that read lands as the turn ends, which is why the Pricing
    // Tool calls tab used to appear during a turn and vanish
    // the moment it finished.
    const storedToolAccounting =
      includeAccounting
      && typeof this.overlayStore.readThreadToolAccounting === "function"
        ? await this.overlayStore.readThreadToolAccounting({
            backend,
            ...(request.includeAllToolInvocations
              ? { includeAllInvocations: true }
              : {}),
            threadId: request.threadId,
          })
        : undefined;
    const toolAccounting = storedToolAccounting
      ? await this.threadUsageLedger.withTokenMiserAccounting({
          accounting: storedToolAccounting,
          backend,
          threadId: request.threadId,
        })
      : undefined;
    const pendingRequest = this.getPendingRequestForThread({
      backend,
      threadId: request.threadId,
    });
    return {
      backend,
      fetchedAt: Date.now(),
      ...(pricing ? { pricing } : {}),
      threadId: request.threadId,
      ...(overlay?.tokenMiserEnabled !== undefined
        ? { tokenMiserEnabled: overlay.tokenMiserEnabled }
        : {}),
      ...(overlay?.monitorJobSuggestionsEnabled !== undefined
        ? { monitorJobSuggestionsEnabled: overlay.monitorJobSuggestionsEnabled }
        : {}),
      ...(toolAccounting ? { toolAccounting } : {}),
      ...(pendingRequest ? { pendingRequest } : {}),
      ...(replayWithReviewMetadata.threadStatus
        ? { threadStatus: replayWithReviewMetadata.threadStatus }
        : {}),
      replay: replayWithReviewMetadata,
    };
  }

  private async startAcpSession(params: {
    backend: AcpBackendId;
    cwd?: string;
    executionMode: ThreadExecutionMode;
    acpRuntime?: BackendAcpSessionRuntimeState;
    reasoningEffort?: string;
    mcpRegistration?: AcpMcpServerRegistration;
    hidden?: boolean;
  }): Promise<{ threadId: string }> {
    if (params.executionMode === "auto") {
      throw new Error("Auto access is supported only by Codex.");
    }
    const client = await this.acpBackend.getClient(params.backend);
    const initialExecutionMode = this.usesSlashControlledAcpExecutionModes(
      params.backend,
    )
      ? "default"
      : params.executionMode;
    const session = await this.withArchiveWorkspaceWrite(params.cwd ? [params.cwd] : [], async () => await client.startSession({
      cwd: params.cwd,
      executionMode: initialExecutionMode,
      acpRuntime: params.acpRuntime,
      additionalMcpRegistration: params.mcpRegistration,
      ...(params.hidden ? { hidden: true } : {}),
    }));
    if (
      this.usesSlashControlledAcpExecutionModes(params.backend) &&
      params.executionMode !== "default"
    ) {
      await this.applySlashControlledAcpThreadExecutionMode({
        backend: params.backend,
        threadId: session.sessionId,
        executionMode: params.executionMode,
      });
    }
    await this.applyAcpRuntimeSelection(
      params.backend,
      client,
      session.sessionId,
      params.acpRuntime,
      params.reasoningEffort,
    );
    return { threadId: session.sessionId };
  }

  private async startAcpTurn(params: {
    backend: AcpBackendId;
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
    reasoningEffort?: string;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    return await this.acpSessionPromptLocks.run(
      executionModeQueueKey(params.backend, params.threadId),
      async () => await this.startAcpTurnLocked(params),
    );
  }

  private async startAcpTurnLocked(params: {
    backend: AcpBackendId;
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
    reasoningEffort?: string;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    const promptPayload = await inputToAcpPrompt(params.input, {
      owner: { backend: params.backend, threadId: params.threadId },
      privateStorageRoots: this.localFilePrivateStorageRoots,
    });
    if (!promptPayload) {
      throw new Error("ACP turns require text or image input");
    }

    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    await this.acpBackend.prepareSessionEnvironment(
      params.backend,
      params.threadId,
      setupVariablesForAgent(
        overlay?.codexEnvironmentRuntime,
        this.resolvePassSetupVariablesToAgentsFn(),
      ),
    );
    const client = await this.acpBackend.getClientForSession(
      params.backend,
      params.threadId,
    );
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session) {
      throw new Error(`ACP session not found: ${params.threadId}`);
    }
    let sessionForTurn = await this.resolveAcpSessionForTurn(params.backend, session);
    if (
      sessionForTurn.requiresAgentSessionRebind ||
      (sessionForTurn.cwd && sessionForTurn.cwd !== session.cwd)
    ) {
      await this.threadWorkspaceService.assertAcpSessionCanRebindForWorkspace(params.backend, sessionForTurn);
      sessionForTurn = await this.threadWorkspaceService.rebindAcpSessionForWorkspace(client, sessionForTurn);
    } else {
      try {
        await client.ensureSession(sessionForTurn);
      } catch (error) {
        if (!isAcpSessionMissingForProjectError(error)) {
          throw error;
        }
        await this.threadWorkspaceService.assertAcpSessionCanRebindForWorkspace(params.backend, sessionForTurn);
        sessionForTurn = await this.threadWorkspaceService.rebindAcpSessionForWorkspace(client, sessionForTurn);
      }
    }
    const runtimeCapabilities =
      this.acpBackend.getInstalledAgent(params.backend)?.runtimeCapabilities;
    const modelConfigOption =
      findAcpModelConfigOption(runtimeCapabilities);
    const thoughtLevelConfigOption =
      findAcpThoughtLevelConfigOption(runtimeCapabilities);
    const currentModel =
      (modelConfigOption
        ? sessionForTurn.acpRuntime?.configValues?.[modelConfigOption.id]
        : undefined) ??
      sessionForTurn.acpRuntime?.currentModelId;
    const currentReasoningEffort =
      (thoughtLevelConfigOption
        ? sessionForTurn.acpRuntime?.configValues?.[
            thoughtLevelConfigOption.id
          ]
        : undefined) ??
      sessionForTurn.acpRuntime?.reasoningEffort;
    if (
      params.model
      && (
        currentModel !== params.model
        || acpModelWriteWouldApplyThoughtLevel({
          client,
          currentReasoningEffort,
          reasoningEffort: params.reasoningEffort,
          threadId: params.threadId,
        })
      )
    ) {
      await client.setRuntimeOption?.({
        sessionId: params.threadId,
        source: "model",
        optionId: "model",
        value: params.model,
        reasoningEffort: params.reasoningEffort,
      });
    }
    const syntheticStartedTurnId = `pending:${params.threadId}:${Date.now()}`;
    await this.emit({
      backend: params.backend,
      notification: {
        method: "turn/started",
        params: {
          threadId: params.threadId,
          turnId: syntheticStartedTurnId,
          turn: {
            id: syntheticStartedTurnId,
            status: "in_progress",
            startedAt: Date.now(),
          },
        },
      },
    });

    try {
      const result = client.startPrompt({
        sessionId: params.threadId,
        prompt: promptPayload.prompt,
        promptContent: promptPayload.promptContent,
        parts: promptPayload.parts,
        turnId: syntheticStartedTurnId,
        // ACP has no instruction field. The client sends these ahead of the
        // prompt when the agent session has not been sent this text.
        agentInstructions: providerDeliveredAgentInstructions(overlay?.agent) ?? "",
        ...(overlay?.agent ? { readAgentMemory: () => this.readAgentMemoryContext(params) } : {}),
      });
      this.invalidateThreadListCache(params.backend);
      return {
        backend: params.backend,
        threadId: result.sessionId,
        turnId: result.turnId,
      };
    } catch (error) {
      await this.emit({
        backend: params.backend,
        notification: {
          method: "turn/failed",
          params: {
            threadId: params.threadId,
            turnId: syntheticStartedTurnId,
            turn: {
              id: syntheticStartedTurnId,
              status: "failed",
              completedAt: Date.now(),
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            },
          },
        },
      });
      throw error;
    }
  }

  // `reasoningEffort` is sent with `runtime.currentModelId`, so it must be a
  // level of that model. On Kimi the model decides which levels exist, and a
  // level chosen for another model is refused with -32602.
  private async applyAcpRuntimeSelection(
    backend: AcpBackendId,
    client: AcpRuntimeClient,
    sessionId: string,
    runtime: BackendAcpSessionRuntimeState | undefined,
    reasoningEffort?: string,
  ): Promise<void> {
    // A thought level is only valid for the model the session holds, so the
    // model's option has to be written first. `configValues` carries whatever
    // insertion order earlier merges left, and a level measured against the
    // agent's default model is dropped by the session's own menu.
    const capabilities = this.acpBackend.getInstalledAgent(backend)?.runtimeCapabilities;
    const thoughtLevelOptionId = findAcpThoughtLevelConfigOption(capabilities)?.id;
    const modeConfigOption = capabilities?.configOptions?.find(
      (option) => option.category === "mode"
        && option.id !== findAcpPermissionModeConfigOption(capabilities)?.id
        && option.values.some((value) => value.value === runtime?.currentModeId),
    );
    // Legacy mode selectors mirror currentModeId. The independent permission
    // config owns its value in configValues; currentModeId remains planning.
    const configValues = Object.entries({
      ...runtime?.configValues,
      ...(modeConfigOption && runtime?.currentModeId
        ? { [modeConfigOption.id]: runtime.currentModeId }
        : {}),
    }).sort(
      ([left], [right]) =>
        Number(left === thoughtLevelOptionId)
        - Number(right === thoughtLevelOptionId),
    );
    for (const [optionId, value] of configValues) {
      await client.setRuntimeOption?.({
        sessionId,
        source: "configOption",
        optionId,
        value,
      });
    }
    if (runtime?.currentModeId && !modeConfigOption) {
      await client.setRuntimeOption?.({
        sessionId,
        source: "mode",
        optionId: "mode",
        value: runtime.currentModeId,
      });
    }
    if (runtime?.currentModelId) {
      await client.setRuntimeOption?.({
        sessionId,
        source: "model",
        optionId: "model",
        value: runtime.currentModelId,
        reasoningEffort,
      });
    }
  }

  setAcpSessionRuntimeOption(
    params: SetAcpSessionRuntimeOptionRequest,
  ): Promise<SetAcpSessionRuntimeOptionResponse> {
    return this.acpSessionRuntimeOptions.setAcpSessionRuntimeOption(params);
  }

  private async resolveAcpSessionForTurn(
    backend: AcpBackendId,
    session: AcpSessionMetadata,
  ): Promise<AcpSessionMetadata> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend,
      threadId: session.sessionId,
    });
    const workspaceCwd = resolveThreadWorkspaceCwd(
      acpSessionToThreadSummary(session),
      overlay?.extraLinkedDirectories,
    );
    if (!workspaceCwd || workspaceCwd === session.cwd) {
      return session;
    }

    return {
      ...session,
      cwd: workspaceCwd,
      requiresAgentSessionRebind: true,
      updatedAt: Math.max(session.updatedAt, Date.now()),
    };
  }

  startCodexAppServerRecycler(): void {
    return this.codexRuntimeSupervisor.startCodexAppServerRecycler();
  }

  readCodexAppServerDiagnostics(): Promise<{
    process?: CodexAppServerProcessSample;
    recycle: CodexAppServerRecycleStatus;
    settings: CodexAppServerRecycleSettings;
  }> {
    return this.codexRuntimeSupervisor.readCodexAppServerDiagnostics();
  }

  startCodexIdleThreadUnsubscriber(): void {
    return this.codexRuntimeSupervisor.startCodexIdleThreadUnsubscriber();
  }

  startThreadArchiveSweeper(): void {
    return this.threadArchiveCoordinator.startThreadArchiveSweeper();
  }

  /**
   * Close idle ACP sessions on a timer (`closeIdleAcpSessions`). Started by
   * the app after startup discovery, like the archive sweeper; tests that
   * never call this get no timer.
   */
  startAcpIdleSessionCloser(): void {
    if (this.closed || this.shutdownRequested || this.acpIdleSessionTimer) return;
    this.acpIdleSessionTimer = setInterval(() => {
      void this.closeIdleAcpSessions();
    }, ACP_SESSION_IDLE_CLOSE_CHECK_INTERVAL_MS);
    this.acpIdleSessionTimer.unref?.();
  }

  /** One pass over the ACP sessions every live agent process keeps open. */
  async closeIdleAcpSessions(): Promise<void> {
    if (this.closed || this.shutdownRequested || this.acpIdleSessionSweep) return;
    const sweep = this.acpBackend.closeIdleSessions({
      idleMs: this.acpSessionIdleCloseMs,
      isSessionBusy: (backend, threadId) => this.closed
        || this.shutdownRequested
        || this.acpSessionNeedsLiveEvents(backend, threadId),
    }).catch((error) => {
      backendRegistryLog.warn("idle ACP session close failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      this.acpIdleSessionSweep = undefined;
    });
    this.acpIdleSessionSweep = sweep;
    await sweep;
  }

  /**
   * Work on an ACP thread that needs its session open: a turn, a reserved
   * turn start or a review (`threadHasActiveTurn`), or queued input.
   */
  private acpSessionNeedsLiveEvents(backend: AcpBackendId, threadId: string): boolean {
    return this.threadHasActiveTurn(threadId, backend)
      || !this.threadTurnQueue.iterateQueuedEntries({ backend, threadId }).next().done;
  }

  sweepInactiveThreads(options: { manual?: boolean } = {}): Promise<void> {
    return this.threadArchiveCoordinator.sweepInactiveThreads(options);
  }

  getThreadArchiveSweepStatus(): DesktopThreadArchiveSweepStatus {
    return this.threadArchiveCoordinator.getThreadArchiveSweepStatus();
  }

  onThreadArchiveSweepStatusChanged(
    listener: (status: DesktopThreadArchiveSweepStatus) => void,
  ): () => void {
    return this.threadArchiveCoordinator.onThreadArchiveSweepStatusChanged(listener);
  }

  listAutoArchiveCandidates(onProgress?: (progress: MaintenanceDiscoveryProgress) => void): Promise<ThreadArchiveCandidate[]> {
    return this.threadArchiveCoordinator.listAutoArchiveCandidates(onProgress);
  }

  resolveAutoArchiveProject({ thread, overlay }: ThreadArchiveCandidate): Promise<string | undefined> {
    return this.threadArchiveCoordinator.resolveAutoArchiveProject({ thread, overlay });
  }

  withThreadLifecycleMutation<T>(
    identity: { backend?: AppServerBackendKind; threadId: string; sourcePath?: string; targetPath?: string; repositoryPath?: string; worktreePath?: string },
    work: (finishMutation: () => void) => Promise<T>,
  ): Promise<T> {
    return this.threadArchiveCoordinator.withThreadLifecycleMutation(identity, work);
  }

  readCheckoutHibernation(identity: { backend: AppServerBackendKind; threadId: string }): {
    restoring: boolean;
    /** The running restore, while it lasts: kept after the snapshot record
     * reads restored, so the card stays through project setup. */
    progress?: ThreadHibernatedWorkspace;
    restoreFailure?: { worktreePath: string; message: string };
  } {
    return this.threadArchiveCoordinator.readCheckoutHibernation(identity);
  }

  setThreadCheckoutHibernation(request: {
    backend: AppServerBackendKind;
    threadId: string;
    restore?: boolean;
    keepAwake?: boolean;
  }): Promise<SetThreadCheckoutHibernationResponse> {
    return this.threadArchiveCoordinator.setThreadCheckoutHibernation(request);
  }

  wakeHibernatedCheckoutOnOpen(identity: { backend: AppServerBackendKind; threadId: string }): Promise<boolean> {
    return this.threadArchiveCoordinator.wakeHibernatedCheckoutOnOpen(identity);
  }

  observeArchivedThreads(
    records: Array<{ backend: AppServerBackendKind; threadId: string }>,
    now: number,
    options?: { promoteSubthreads: boolean },
  ): Promise<void> {
    return this.threadArchiveCoordinator.observeArchivedThreads(records, now, options);
  }

  publishArchivedThreadAutomationRetirements(retired: ArchivedThreadAutomationRetirement[]): Promise<void> {
    return this.threadArchiveCoordinator.publishArchivedThreadAutomationRetirements(retired);
  }

  archiveThread(
    request: ArchiveThreadRequest & { preserveWorktrees?: boolean },
  ): Promise<ArchiveThreadResponse> {
    return this.threadArchiveCoordinator.archiveThread(request);
  }

  getArchiveCleanupCountForQuit(): number {
    return this.threadArchiveCoordinator.getArchiveCleanupCountForQuit();
  }

  checkpointArchiveCleanupsForQuit(): void {
    return this.threadArchiveCoordinator.checkpointArchiveCleanupsForQuit();
  }

  resumeArchiveCleanupsAtStartup(): Promise<void> {
    return this.threadArchiveCoordinator.resumeArchiveCleanupsAtStartup();
  }

  restoreThread(
    request: RestoreThreadRequest,
  ): Promise<RestoreThreadResponse> {
    return this.threadArchiveCoordinator.restoreThread(request);
  }

  archiveWorktree(
    request: ArchiveWorktreeRequest,
  ): Promise<ArchiveWorktreeResponse> {
    return this.threadArchiveCoordinator.archiveWorktree(request);
  }

  restoreWorktree(
    request: RestoreWorktreeRequest,
  ): Promise<RestoreWorktreeResponse> {
    return this.threadArchiveCoordinator.restoreWorktree(request);
  }

  handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse> {
    return this.threadWorkspaceService.handoffThreadWorkspace(request);
  }

  recreateThreadWorktree(
    request: RecreateThreadWorktreeRequest,
  ): Promise<RecreateThreadWorktreeResponse> {
    return this.threadWorkspaceService.recreateThreadWorktree(request);
  }

  moveThreadToMainCheckout(
    request: MoveThreadToMainCheckoutRequest,
  ): Promise<MoveThreadToMainCheckoutResponse> {
    return this.threadWorkspaceService.moveThreadToMainCheckout(request);
  }

  readThreadWorktreeLock(request: ReadThreadWorktreeLockRequest): Promise<ReadThreadWorktreeLockResponse> {
    return this.threadWorkspaceService.readThreadWorktreeLock(request);
  }

  /** Only from the operator's explicit choice; never an automatic path or an agent tool. */
  removeLockedThreadWorktrees(request: RemoveLockedThreadWorktreesRequest): Promise<RemoveLockedThreadWorktreesResponse> {
    return this.threadArchiveCoordinator.removeLockedThreadWorktrees(request);
  }

  async renameThread(request: RenameThreadRequest, options?: ThreadRenameOptions): Promise<RenameThreadResponse> {
    return await this.threadNaming.renameThread(request, options);
  }

  private readonly threadNaming = new ThreadNamingLifecycle({
    readName: async ({ backend, threadId }) => backend === "codex"
      ? await this.withCodexThreadClient(threadId, async (client) => {
          if (!client.readThreadName) throw new Error("Persisted thread names are unavailable.");
          const title = await client.readThreadName(threadId);
          const metadata = await this.overlayStore.getThreadMetadata?.({ backend, threadId });
          return projectOwnerThreadTitle({ title: title ?? "", titleSource: title ? "explicit" : "fallback" }, metadata).title || undefined;
        })
      : (await this.threadInspectionTools.readThreadInspectionSummaryForMutation({ backend, threadId, fresh: true }))?.title,
    readTitle: async (identity) => await this.findThreadForTitleGeneration(identity),
    renameProvider: async (request, titleSource) => {
      const backend = request.backend ?? "codex";
      if (isAcpBackendId(backend)) {
        const nextName = request.name.trim();
        if (!nextName) throw new Error("Thread name cannot be blank.");
        const session = this.acpBackend.getSession(backend, request.threadId);
        if (!session) throw new Error("Selected ACP thread was not found.");
        this.acpBackend.upsertSession({
          ...session,
          title: nextName,
          titleSource,
          updatedAt: Math.max(session.updatedAt, Date.now()),
        });
        return { threadId: request.threadId };
      }
      if (backend === "claude") return await this.claudeBackend.renameThread(request.threadId, request.name);
      if (backend === "codex") return await this.withCodexThreadClient(request.threadId, async (client) =>
        await this.renameWithClient(client, request.threadId, request.name));
      throw new Error(`Unsupported backend: ${backend}`);
    },
    getAgent: async (identity) => await this.getThreadAgentMetadata(identity),
    setAgent: async (identity, agent) => { await this.overlayStore.setThreadAgent({ ...identity, agent }); },
    invalidate: (backend) => this.invalidateThreadListCache(backend),
    emit: async (event) => { await this.emit(event); },
    now: () => Date.now(),
  });

  async readSelectedWorkspaceGitStatus(path: string): Promise<NavigationDirectoryGitStatus | undefined> {
    return this.gitDirectoryService.readDirectoryStatus({ path });
  }

  async readDirectoryStatuses(directories: NavigationDirectorySummary[]): Promise<
    Record<string, NavigationDirectoryGitStatus | undefined>
  > {
    return await this.gitDirectoryService.readDirectoryStatuses(directories);
  }

  readDirectoryStatusEntries<T extends Pick<NavigationDirectorySummary, "key" | "path">>(
    directories: T[],
    request: GitReadRequest = {},
  ): AsyncIterable<DirectoryGitStatusEntry> {
    return this.gitDirectoryService.readDirectoryStatusEntries(directories, request);
  }

  async refreshDirectoryGitStatuses(
    request: RefreshDirectoryGitStatusesRequest,
  ): Promise<RefreshDirectoryGitStatusesResponse> {
    const directoryKeys = [
      ...new Set(request.directoryKeys.map((key) => key.trim()).filter(Boolean)),
    ];
    const directories = directoryKeys
      .map((key) => this.navigationDirectoriesByKey.get(key))
      .filter((directory): directory is NavigationDirectorySummary =>
        Boolean(directory?.path?.trim()),
      )
      .filter((directory) => !this.pendingDirectoryGitStatusKeys.has(directory.key));
    for (const directory of directories) {
      this.pendingDirectoryGitStatusKeys.add(directory.key);
    }
    void this.refreshDirectoryGitStatusesInBackground(directories, {
      userAction: request.force !== false, caller: "directory-status-rpc",
    });
    return { scheduledCount: directories.length };
  }

  private async refreshDirectoryGitStatusesInBackground(
    directories: NavigationDirectorySummary[],
    request: GitReadRequest,
  ): Promise<void> {
    try {
      for await (const entry of this.gitDirectoryService.readDirectoryStatusEntries(
        directories,
        request,
      )) {
        const fetchedAt = Date.now();
        const directory = this.navigationDirectoriesByKey.get(entry.directoryKey);
        if (this.directoryGitStatusWriter) {
          await this.directoryGitStatusWriter({
            directory,
            directoryKey: entry.directoryKey,
            fetchedAt,
            gitStatus: entry.gitStatus,
          });
          continue;
        }
        const notification: NavigationDirectoryGitStatusUpdatedNotification = {
          method: "navigation/directoryGitStatus/updated",
          params: {
            directoryKey: entry.directoryKey,
            gitStatus: entry.gitStatus ?? null,
            fetchedAt,
          },
        };
        await this.emit({
          backend: "codex",
          notification,
        } as unknown as AgentEvent);
      }
    } catch (error) {
      backendRegistryLog.warn("directory Git status refresh failed", {
        directoryKeys: directories.map((directory) => directory.key),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      for (const directory of directories) {
        this.pendingDirectoryGitStatusKeys.delete(directory.key);
      }
    }
  }

  readWorktreeWorkingStateEntries(
    worktreePaths: string[],
    options?: GitWorkingStateEntryOptions,
  ): AsyncIterable<WorktreeWorkingStateEntry> {
    return this.gitWorkingStateService.readWorkingStateEntries(worktreePaths, options);
  }

  /**
   * Hydrate the durable working-state view at the backend boundary so every
   * navigation consumer (renderer IPC, messaging, and future transports) sees
   * the same review-selection evidence. Normal navigation only reads the
   * durable cache and lets `refreshThreadGitWorkingStates` converge the rest.
   * A caller that cannot tolerate a stale answer awaits the probe instead.
   */
  async hydrateThreadGitWorkingStates<Thread extends AppServerThreadSummary>(
    threads: Thread[],
    options: { probeMissing?: boolean } = {},
  ): Promise<Thread[]> {
    const candidates = threads.filter(
      (thread) => !thread.gitWorkingState && resolveThreadWorkingStatePath(thread),
    );
    if (candidates.length === 0) {
      return threads;
    }

    await this.loadThreadGitWorkingStateCache();
    const hydrated = this.applyCachedThreadGitWorkingStates(threads);
    if (!options.probeMissing) {
      return hydrated;
    }

    const probePaths = this.selectStaleThreadWorkingStatePaths(candidates, {
      multiProjectOnly: true,
    });
    if (probePaths.length === 0) {
      return hydrated;
    }

    try {
      await this.probeThreadGitWorkingStates(threads, probePaths);
    } catch (error) {
      backendRegistryLog.warn("review working-state probe failed", {
        error: error instanceof Error ? error.message : String(error),
        worktreePaths: probePaths,
      });
      return hydrated;
    }

    return this.applyCachedThreadGitWorkingStates(threads);
  }

  /**
   * Schedule the fleet that `hydrateThreadGitWorkingStates` would otherwise
   * await. A navigation serving path calls this so its snapshot answers from
   * the durable cache and converges on a later read, which is what the
   * renderer's local navigation path already does. Requests for the same
   * worktree coalesce, and each round probes a bounded batch.
   */
  async refreshThreadGitWorkingStates<Thread extends AppServerThreadSummary>(
    threads: Thread[],
    options: { limit?: number } = {},
  ): Promise<{ scheduledCount: number }> {
    if (this.closed) {
      return { scheduledCount: 0 };
    }

    await this.loadThreadGitWorkingStateCache();
    // One registry-owned automatic fleet round spans every navigation
    // surface. Before this gate, repeated renderer and messaging snapshots
    // reached past the paths already in flight and started rotating batches
    // concurrently. That turned serving-path frequency into Git fleet size.
    if (this.threadGitWorkingStateRefreshRound) {
      return { scheduledCount: 0 };
    }
    // Staleness is decided in exactly one place: the cache. Filtering threads
    // on `gitWorkingState` here would read the field a serving path has just
    // hydrated from that same cache, so a worktree with any row — however old
    // — would never be probed again and nothing would ever converge.
    //
    // Exclude in-flight worktrees before the cap, not after: a round whose
    // whole batch is already in flight must still reach the paths behind it.
    const worktreePaths = this.selectStaleThreadWorkingStatePaths(
      threads.filter((thread) => thread.threadStatus === "active"),
      {
        exclude: new Set(this.pendingThreadGitWorkingStateByPath.keys()),
        limit: options.limit ?? BACKGROUND_WORKTREE_WORKING_STATE_BATCH_SIZE,
      },
    );
    if (worktreePaths.length === 0) {
      return { scheduledCount: 0 };
    }

    // Carry only the threads behind this batch. The round outlives the
    // snapshot that scheduled it, and retaining every thread would hold a full
    // navigation snapshot for as long as the Git fleet runs.
    const batched = new Set(worktreePaths);
    const probedThreads = threads.filter((thread) => {
      const worktreePath = resolveThreadWorkingStatePath(thread);
      return worktreePath !== undefined && batched.has(worktreePath);
    });
    const round = this.refreshThreadGitWorkingStatesInBackground(
      probedThreads,
      worktreePaths,
    );
    for (const worktreePath of worktreePaths) {
      this.pendingThreadGitWorkingStateByPath.set(worktreePath, round);
    }
    this.threadGitWorkingStateRefreshRound = round;
    void round.finally(() => {
      for (const worktreePath of worktreePaths) {
        if (this.pendingThreadGitWorkingStateByPath.get(worktreePath) === round) {
          this.pendingThreadGitWorkingStateByPath.delete(worktreePath);
        }
      }
      if (this.threadGitWorkingStateRefreshRound === round) {
        this.threadGitWorkingStateRefreshRound = undefined;
      }
    });
    return { scheduledCount: worktreePaths.length };
  }

  private async refreshThreadGitWorkingStatesInBackground<
    Thread extends AppServerThreadSummary,
  >(threads: Thread[], worktreePaths: string[]): Promise<void> {
    try {
      await this.probeThreadGitWorkingStates(threads, worktreePaths);
    } catch (error) {
      backendRegistryLog.warn("thread working-state refresh failed", {
        error: error instanceof Error ? error.message : String(error),
        worktreePaths,
      });
    }
  }

  /**
   * Schedule one focused, user-triggered, or event-triggered refresh through
   * the same per-worktree ownership map as the automatic fleet. If an older
   * automatic probe is active, queue exactly one follow-up instead of racing
   * it. Later requests update a queued probe, or request one bounded rerun
   * when the focused probe has already started.
   */
  scheduleWorktreeGitWorkingStateRefresh(params: {
    userAction?: boolean;
    acceptedPushedCommitShas?: string[];
    worktreePath: string;
  }): boolean {
    const worktreePath = params.worktreePath.trim();
    if (this.closed || !worktreePath) {
      return false;
    }
    const existingFocused =
      this.focusedThreadGitWorkingStateRefreshByPath.get(worktreePath);
    if (existingFocused) {
      existingFocused.acceptedPushedCommitShas =
        params.acceptedPushedCommitShas;
      existingFocused.userAction ||= params.userAction;
      if (existingFocused.running) {
        existingFocused.rerunRequested = true;
      }
      return false;
    }

    const previous = this.pendingThreadGitWorkingStateByPath.get(worktreePath);
    const focused = {
      userAction: params.userAction,
      acceptedPushedCommitShas: params.acceptedPushedCommitShas,
      rerunRequested: false,
      running: false,
    };
    this.focusedThreadGitWorkingStateRefreshByPath.set(worktreePath, focused);
    let refresh: Promise<void>;
    refresh = (async () => {
      if (previous) {
        await previous;
      }
      do {
        if (this.closed) {
          return;
        }
        focused.rerunRequested = false;
        focused.running = true;
        const userAction = focused.userAction;
        focused.userAction = false;
        try {
          await this.probeFocusedWorktreeGitWorkingState(
            worktreePath,
            focused.acceptedPushedCommitShas,
            userAction,
          );
        } catch (error) {
          backendRegistryLog.warn("focused working-state refresh failed", {
            error: error instanceof Error ? error.message : String(error),
            worktreePath,
          });
        } finally {
          focused.running = false;
        }
      } while (focused.rerunRequested);
    })().finally(() => {
      if (
        this.focusedThreadGitWorkingStateRefreshByPath.get(worktreePath)
        === focused
      ) {
        this.focusedThreadGitWorkingStateRefreshByPath.delete(worktreePath);
      }
      if (this.pendingThreadGitWorkingStateByPath.get(worktreePath) === refresh) {
        this.pendingThreadGitWorkingStateByPath.delete(worktreePath);
      }
      this.focusedThreadGitWorkingStateRefreshes.delete(refresh);
    });
    this.pendingThreadGitWorkingStateByPath.set(worktreePath, refresh);
    this.focusedThreadGitWorkingStateRefreshes.add(refresh);
    return true;
  }

  private async probeFocusedWorktreeGitWorkingState(
    worktreePath: string,
    acceptedPushedCommitShas: string[] | undefined,
    userAction?: boolean,
  ): Promise<void> {
    for await (const entry of this.gitWorkingStateService.readWorkingStateEntries(
      [worktreePath],
      {
        ...(userAction ? { userAction: true, caller: "working-state-refresh" } : {}),
        acceptedPushedCommitShasByWorktreePath: {
          [worktreePath]: acceptedPushedCommitShas,
        },
      },
    )) {
      await this.rememberThreadGitWorkingStateCacheEntry({
        ...entry,
        fetchedAt: Date.now(),
      });
    }
  }

  /**
   * Everything registry-specific about picking a batch, and nothing else:
   * resolving threads to worktree paths, and the `multiProjectOnly` narrowing.
   * Freshness, the cap, and the rotation order are shared policy — see
   * `thread-working-state-refresh-policy.ts`.
   *
   * `multiProjectOnly` belongs to the awaited review probe, whose whole job is
   * disambiguating a review target: a single-directory thread's target is
   * unambiguous without working state. The background convergence lane must
   * not inherit it — it feeds the dirty/unpushed/base-drift chips every thread
   * shows.
   */
  private selectStaleThreadWorkingStatePaths<
    Thread extends AppServerThreadSummary,
  >(
    candidates: Thread[],
    options: {
      exclude?: ReadonlySet<string>;
      limit?: number;
      multiProjectOnly?: boolean;
    } = {},
  ): string[] {
    return selectStaleWorktreeWorkingStatePaths({
      cache: this.workingStateByWorktree,
      ...(options.exclude ? { exclude: options.exclude } : {}),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      worktreePaths: candidates.flatMap((thread) => {
        if (options.multiProjectOnly && thread.linkedDirectories.length <= 1) {
          return [];
        }
        const worktreePath = resolveThreadWorkingStatePath(thread);
        return worktreePath ? [worktreePath] : [];
      }),
    });
  }

  private async probeThreadGitWorkingStates<
    Thread extends AppServerThreadSummary,
  >(threads: Thread[], worktreePaths: string[]): Promise<void> {
    const acceptedPushedCommitShasByWorktreePath =
      await this.readAcceptedPublishedPrCommitShasByWorktreePath(
        threads,
        worktreePaths,
      );
    for await (const entry of this.gitWorkingStateService.readWorkingStateEntries(
      worktreePaths,
      { acceptedPushedCommitShasByWorktreePath },
    )) {
      await this.rememberThreadGitWorkingStateCacheEntry({
        ...entry,
        fetchedAt: Date.now(),
      });
    }
  }

  private async readAcceptedPublishedPrCommitShasByWorktreePath<
    Thread extends AppServerThreadSummary,
  >(
    threads: Thread[],
    worktreePaths: string[],
  ): Promise<Record<string, string[]>> {
    const acceptedByWorktreePath = new Map(
      worktreePaths.map((worktreePath) => [worktreePath, new Set<string>()]),
    );
    await Promise.all(threads.map(async (thread) => {
      const worktreePath = resolveThreadWorkingStatePath(thread);
      const accepted = worktreePath
        ? acceptedByWorktreePath.get(worktreePath)
        : undefined;
      if (!accepted) {
        return;
      }
      const overlay = await this.overlayStore.getThreadOverlayState({
        backend: thread.source,
        threadId: thread.id,
      });
      const visiblePrs = (thread as Thread & { prs?: PrSummary[] }).prs ?? [];
      const prs = [
        ...visiblePrs,
        ...(overlay?.prs ?? []),
        ...(overlay?.detachedPrs ?? []),
      ];
      let canonicalPrs = prs;
      if (this.forgeToolBridge.pullRequestCanonicalizer && prs.length > 0) {
        try {
          canonicalPrs = await this.forgeToolBridge.pullRequestCanonicalizer(prs);
        } catch (error) {
          backendRegistryLog.warn("working-state PR canonicalization failed", {
            error: error instanceof Error ? error.message : String(error),
            threadId: thread.id,
          });
        }
      }
      for (const commitSha of publishedPrCommitShas(canonicalPrs)) {
        accepted.add(commitSha);
      }
    }));
    return Object.fromEntries(
      [...acceptedByWorktreePath].map(([worktreePath, commitShas]) => [
        worktreePath,
        [...commitShas].sort(),
      ]),
    );
  }

  private applyCachedThreadGitWorkingStates<Thread extends AppServerThreadSummary>(
    threads: Thread[],
  ): Thread[] {
    return threads.map((thread) => {
      if (thread.gitWorkingState) {
        return thread;
      }
      const worktreePath = resolveThreadWorkingStatePath(thread);
      const gitWorkingState = worktreePath
        ? this.workingStateByWorktree.get(worktreePath)?.gitWorkingState
        : undefined;
      return gitWorkingState ? { ...thread, gitWorkingState } : thread;
    });
  }

  /**
   * The one write seam for the working-state cache, for both lanes. Keeping it
   * single is what makes the shared cache safe: the monotonic stamp and the
   * notification below share one seam. Only a meaningful state change emits
   * an event; advancing probe freshness alone must not refresh navigation.
   */
  async rememberThreadGitWorkingStateCacheEntry(
    entry: WorktreeGitWorkingStateCacheEntry,
  ): Promise<void> {
    await this.loadThreadGitWorkingStateCache();
    // Two lanes probing one worktree can land in the same millisecond, and the
    // renderer drops an update whose `fetchedAt` does not advance. Derive the
    // stamp from the entry it replaces rather than trusting the clock.
    const previous = this.workingStateByWorktree.get(entry.worktreePath);
    const fetchedAt = Math.max(
      entry.fetchedAt,
      (previous?.fetchedAt ?? entry.fetchedAt - 1) + 1,
    );
    const stored: WorktreeGitWorkingStateCacheEntry = { ...entry, fetchedAt };
    this.workingStateByWorktree.set(stored.worktreePath, stored);
    await this.overlayStore.writeThreadGitWorkingStateCacheEntry?.(stored);

    if (isDeepStrictEqual(previous?.gitWorkingState ?? null, stored.gitWorkingState ?? null)) return;

    // Reaches already-open surfaces. Without it a background round only landed
    // in the durable cache, so the window that scheduled it kept showing the
    // previous chips until its next full navigation snapshot.
    const notification: NavigationThreadGitWorkingStateUpdatedNotification = {
      method: "navigation/threadGitWorkingState/updated",
      params: {
        worktreePath: stored.worktreePath,
        gitWorkingState: stored.gitWorkingState ?? null,
        fetchedAt,
      },
    };
    await this.publishLocalEvent({
      // Working state belongs to a worktree, not a backend, but every event on
      // this bus carries one. Matches the renderer lane's own publish.
      backend: "codex",
      notification,
    } as unknown as AgentEvent);
  }

  /**
   * Live view of the cache both refresh lanes decide staleness against.
   * Read-only by type: `rememberThreadGitWorkingStateCacheEntry` is the only
   * writer, and the lanes must not each keep their own copy — a second map
   * disagrees about what is fresh and re-probes what the other just read.
   */
  getThreadGitWorkingStateCache(): ReadonlyMap<
    string,
    WorktreeGitWorkingStateCacheEntry
  > {
    return this.workingStateByWorktree;
  }

  async loadThreadGitWorkingStateCache(): Promise<void> {
    if (!this.workingStateCacheLoad) {
      this.workingStateCacheLoad = (async () => {
        const entries =
          await this.overlayStore.readThreadGitWorkingStateCache?.() ?? {};
        for (const entry of Object.values(entries)) {
          this.workingStateByWorktree.set(entry.worktreePath, entry);
        }
      })().catch((error) => {
        this.workingStateCacheLoad = undefined;
        backendRegistryLog.warn("thread working-state cache load failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    await this.workingStateCacheLoad;
  }

  invalidateWorktreeWorkingState(worktreePath?: string): void {
    this.gitWorkingStateService.invalidate(worktreePath);
  }

  async resolveEditCommitStates(
    worktreePath: string,
    groups: EditGroupCommitInput[],
    options?: ResolveEditCommitStatesOptions,
  ): Promise<Record<string, EditGroupCommitState>> {
    return await this.gitWorkingStateService.resolveEditCommitStates(
      worktreePath,
      groups,
      options,
    );
  }

  async listWorktreeOtherChanges(
    worktreePath: string,
    options?: { excludePaths?: string[]; maxFiles?: number },
  ) {
    return await this.gitWorkingStateService.listOtherChanges(worktreePath, options);
  }

  /**
   * A renderer-supplied path matched against the directories the thread works
   * in. The answer is the thread's own spelling of the path, with the rest of
   * its workspaces. Archived threads are found only on request: reading a
   * retained archived checkout is fine, changing one is not.
   */
  private async resolveThreadWorkspace(params: {
    backend?: AppServerBackendKind;
    includeArchived: boolean;
    threadId: string;
    worktreePath: string;
  }) {
    const threadId = params.threadId.trim();
    if (!threadId) return undefined;
    let thread = await this.resolveThread({
      backend: params.backend,
      threadId,
    });
    // Resolve the archive explicitly, independent of which thread list
    // warmed the cache.
    if (!thread && params.includeArchived) {
      thread = (await this.listThreads({
        backend: params.backend, archived: true, enrichDirectories: false,
        forceRefresh: true, callerReason: "thread-id-lookup",
      })).find((candidate) => candidate.id === threadId);
    }
    if (!thread || (!params.includeArchived && thread.archivedAt !== undefined)) {
      return undefined;
    }
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: thread.source,
      threadId: thread.id,
    });
    const workspacePaths = threadWorkspacePaths(thread, overlay?.extraLinkedDirectories);
    const worktreePath = matchThreadWorkspacePath(workspacePaths, params.worktreePath);
    return worktreePath ? { thread, overlay, worktreePath, workspacePaths } : undefined;
  }

  /**
   * The same check for an operation that changes files in the directory, such
   * as sharing a worktree's storage. It reads no pull requests, and an
   * archived thread's retained checkout does not qualify.
   */
  async resolveThreadLinkedWorkspace(params: {
    backend?: AppServerBackendKind;
    threadId: string;
    worktreePath: string;
  }): Promise<{ worktreePath: string; workspacePaths: string[] } | undefined> {
    const resolved = await this.resolveThreadWorkspace({ ...params, includeArchived: false });
    return resolved && { worktreePath: resolved.worktreePath, workspacePaths: resolved.workspacePaths };
  }

  /**
   * Whether any thread on this machine that works in `worktreePath` has a
   * turn, a reserved turn start, or a review running, or work that outlives
   * a turn: a Codex background terminal, live tool call or sub-agent, or a
   * Claude background task. Threads can share a worktree, so the thread
   * that asks is not the only possible writer.
   */
  async workspaceHasActiveTurn(worktreePath: string): Promise<boolean> {
    const threads = await this.listThreads({
      archived: false, enrichDirectories: false, callerReason: "workspace-active-turn",
    });
    const claudeTaskOwners = new Set(this.claudeBackend.backgroundTaskThreadIds());
    for (const thread of threads) {
      // Few threads run at once, so only those pay for an overlay read.
      const working = this.threadHasActiveTurn(thread.id, thread.source)
        || (thread.source === "codex" && this.codexRuntimeSupervisor.codexThreadBoundToAppServer(thread.id))
        || (thread.source === "claude" && claudeTaskOwners.has(thread.id));
      if (!working) continue;
      const overlay = await this.overlayStore.getThreadOverlayState({
        backend: thread.source,
        threadId: thread.id,
      });
      const paths = threadWorkspacePaths(thread, overlay?.extraLinkedDirectories);
      if (matchThreadWorkspacePath(paths, worktreePath)) return true;
    }
    return false;
  }

  /**
   * Resolve a renderer-supplied worktree path against the owning thread before
   * a federated peer can read commit metadata from it. The peer supplies the
   * path it rendered, but this instance remains authoritative for both the
   * linked-directory boundary and published-PR exclusions.
   */
  async resolveThreadWorktreeGitReadContext(params: {
    backend?: AppServerBackendKind;
    threadId: string;
    worktreePath: string;
  }): Promise<{
    acceptedPushedCommitShas: string[];
    worktreePath: string;
  } | undefined> {
    // Read-only Git access includes retained archived checkouts.
    const resolved = await this.resolveThreadWorkspace({ ...params, includeArchived: true });
    if (!resolved) return undefined;
    const { thread, overlay, worktreePath: matchedPath } = resolved;
    const storedPrs = [
      ...(overlay?.prs ?? []),
      ...(overlay?.detachedPrs ?? []),
    ];
    let canonicalPrs = storedPrs;
    if (this.forgeToolBridge.pullRequestCanonicalizer && storedPrs.length > 0) {
      try {
        canonicalPrs = await this.forgeToolBridge.pullRequestCanonicalizer(storedPrs);
      } catch (error) {
        backendRegistryLog.warn("federated commit PR canonicalization failed", {
          error: error instanceof Error ? error.message : String(error),
          threadId: thread.id,
        });
      }
    }
    return {
      worktreePath: matchedPath,
      acceptedPushedCommitShas: publishedPrCommitShas(canonicalPrs),
    };
  }

  async getWorktreeOtherChangeDiff(
    worktreePath: string,
    filePath: string,
    options?: { maxBytes?: number },
  ) {
    return await this.gitWorkingStateService.getOtherChangeDiff(
      worktreePath,
      filePath,
      options,
    );
  }

  async listWorktreeUnpublishedCommits(
    worktreePath: string,
    options?: {
      acceptedPushedCommitShas?: string[];
      maxCommits?: number;
      maxFilesPerCommit?: number;
    },
  ) {
    return await this.gitWorkingStateService.listUnpublishedCommits(
      worktreePath,
      options,
    );
  }

  async getWorktreeUnpublishedCommitDiff(
    worktreePath: string,
    commitSha: string,
    filePath: string,
    options?: { acceptedPushedCommitShas?: string[]; maxBytes?: number },
  ) {
    return await this.gitWorkingStateService.getUnpublishedCommitDiff(
      worktreePath,
      commitSha,
      filePath,
      options,
    );
  }

  async readThread(request: RegistryReadThreadRequest): Promise<AppServerReadThreadResponse> {
    if (!request.preserveAutomaticArchive) {
      this.threadArchiveCoordinator.cancelAutomaticArchive(request.backend ?? "codex", request.threadId);
    }
    const read = () => listingDiagnostics.trace("workflow", { query: !request.display || request.display.resource === "transcript" ? "transcript" : "thread-detail" }, () => this.readThreadDisplay(request));
    return await (request.countsAsActivity === false
      ? withCodexRequestActivity({ countsAsActivity: false }, read)
      : read());
  }

  private async readThreadDisplay(request: AppServerReadThreadRequest): Promise<AppServerReadThreadResponse> {
    if (!request.display) return await this.readThreadData(request);
    const backend = request.backend ?? "codex";
    if (request.display.resource === "activity") {
      this.assertNotBootstrap("readThread");
      const activity = request.display.activity;
      if (backend !== "codex" || !activity?.entryId || !activity.turnId) throw new Error("Invalid activity detail request.");
      if (activity.invocationItemId !== undefined) {
        const itemId = activity.invocationItemId;
        if (!itemId || activity.entryId !== `activity-${itemId}` || activity.itemIds !== undefined) {
          throw new Error("Invalid tool invocation detail request.");
        }
        const details = await this.withCodexThreadClient(request.threadId, async (client) => {
          if (!client.readThreadToolInvocation) throw new Error("Tool invocation detail reads are unavailable.");
          return await client.readThreadToolInvocation({ threadId: request.threadId, turnId: activity.turnId, itemId });
        }, undefined, false);
        return {
          backend, threadId: request.threadId, fetchedAt: Date.now(),
          toolInvocationDetails: { turnId: activity.turnId, itemId, details },
          replay: { entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
        };
      }
      const entry = await this.withCodexThreadClient(request.threadId, async (client) => {
        if (!client.readThreadActivity) throw new Error("Activity detail reads are unavailable.");
        return await client.readThreadActivity({ threadId: request.threadId, ...activity });
      }, undefined, false);
      return {
        backend, threadId: request.threadId, fetchedAt: Date.now(),
        replay: { entries: [{ ...entry, usageLine: undefined }], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
      };
    }
    const overlay = await this.overlayStore.getThreadOverlayState({ backend, threadId: request.threadId });
    if (request.display.resource === "transcript") {
      const data = await this.readThreadData(request);
      return projectThreadDisplay(data, request, {
        ...overlay,
        ...await this.threadUsageLedger.readPricingSubAgents({ backend, threadId: request.threadId, pricing: data.pricing }),
        activeTurnId: this.getActiveTurnForThread({ backend, threadId: request.threadId })?.turnId,
      });
    }
    this.assertNotBootstrap("readThread");
    const pricing = await this.threadUsageLedger.readThreadPricingWithLiveTokenMiser({ backend, threadId: request.threadId });
    if (backend === "codex" && request.display.resource === "pricing"
      && pricing.summaries.length === 0 && !pricing.lines.some((line) => line.status !== "superseded")) {
      const snapshot = await this.withCodexThreadClient(request.threadId, async (client) =>
        await client.readThreadPricingSnapshot?.(request.threadId), undefined, false);
      if (snapshot) {
        const modelLabel = this.codexBackendSummary?.launchpadOptions?.models?.find((model) => model.id === snapshot.model)?.label;
        const localModel = Boolean(snapshot.model && this.resolveCodexLocalModelIdsFn().includes(snapshot.model));
        pricing.snapshot = withCodexProviderSnapshotRates(
          { ...snapshot, ...(modelLabel ? { modelLabel } : {}), localModel },
          this.resolveCodexModelProvidersFn(),
        );
      }
    }
    const stored = await this.overlayStore.readThreadToolAccounting({
      backend, threadId: request.threadId,
      ...(request.display.resource === "tools" || request.display.resource === "incident" ? { includeAllInvocations: true } : {}),
    });
    const toolAccounting = stored ? await this.threadUsageLedger.withTokenMiserAccounting({ accounting: stored, backend, threadId: request.threadId }) : undefined;
    const monitorId = request.display.monitorId;
    // Pricing includes in-memory gates; their parent links and accounting
    // must come from the same live view before grouping and pagination.
    const pricingCards = await this.threadUsageLedger.readPricingSubAgents({ backend, threadId: request.threadId, pricing });
    return projectThreadDisplay({
      backend, threadId: request.threadId, fetchedAt: Date.now(), pricing, toolAccounting,
      replay: { entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
    }, request, {
      ...overlay,
      ...pricingCards,
      ...(request.display.resource === "subagents"
        ? { subAgentPanel: await this.readSubAgentPanel({ backend, request, pricingSubAgents: pricingCards.pricingSubAgents }) }
        : {}),
      ...(request.display.resource === "subagent" && monitorId
        ? { subAgent: (await this.readSubAgentsWithLiveState({ backend, threadId: request.threadId, monitorIds: [monitorId] }))
          .find((card) => card.monitorId === monitorId) }
        : {}),
      activeTurnId: this.getActiveTurnForThread({ backend, threadId: request.threadId })?.turnId,
    });
  }

  /** Cards whose stored row live state replaces: unpersisted gates and held native-worker usage. */
  private liveSubAgentMonitorIds(backend: AppServerBackendKind, threadId: string): string[] {
    if (backend !== "codex") return [];
    return [
      ...this.threadUsageLedger.liveTokenMiserSubAgentRecords.get(threadId)?.keys() ?? [],
      ...this.subAgentMonitorService.liveCodexNativeSubAgentUsageRecords.get(threadId)?.keys() ?? [],
    ];
  }

  /** The named stored cards, with every live card and live usage merged in. */
  private async readSubAgentsWithLiveState(params: {
    backend: AppServerBackendKind;
    threadId: string;
    monitorIds: readonly string[];
  }): Promise<ThreadSubAgentSummary[]> {
    const stored = await this.overlayStore.getThreadSubAgents(params);
    return params.backend === "codex" ? this.mergeLiveTokenMiserSubAgents(params.threadId, stored) : stored;
  }

  /**
   * The sub-agents panel's page from the card table, with live cards merged
   * into it. Pricing's cards already hold every live card with its live state.
   */
  private async readSubAgentPanel(params: {
    backend: AppServerBackendKind;
    request: AppServerReadThreadRequest;
    pricingSubAgents: readonly ThreadSubAgentSummary[] | undefined;
  }): Promise<ThreadSubAgentPanel> {
    const { backend, request } = params;
    const threadId = request.threadId;
    const liveIds = this.liveSubAgentMonitorIds(backend, threadId);
    const live = new Set(liveIds);
    return await readThreadSubAgentPanel({
      demand: request.display!,
      now: Date.now(),
      storedRevision: await this.overlayStore.readThreadSubAgentRevision({ backend, threadId }),
      live: {
        monitorIds: liveIds,
        cards: (params.pricingSubAgents ?? []).filter((card) => live.has(card.monitorId)),
      },
      reader: {
        counts: (read) => this.overlayStore.readThreadSubAgentLensCounts({ backend, threadId, ...read }),
        page: (read) => this.overlayStore.listThreadSubAgentLensPage({ backend, threadId, ...read }),
      },
    });
  }

  private scheduleTranscriptRepairs(threadId: string, replay: AppServerThreadReplay): void {
    if (this.closed) return;
    // Keep only the newest pending replay while a repair runs. Repeated opens
    // must not retain a queue of whole transcripts or repeat stale discovery.
    this.pendingTranscriptRepairReplays.set(threadId, replay);
    if (this.transcriptRepairs.has(threadId)) return;
    const repair = Promise.resolve().then(async () => {
      while (!this.closed) {
        const next = this.pendingTranscriptRepairReplays.get(threadId);
        if (!next) break;
        this.pendingTranscriptRepairReplays.delete(threadId);
        try {
          await joinConcurrent([
            this.threadDirectoryService.repairCodexThreadDirectoryRelationship({ reason: "selected-thread", threadId }),
            this.subAgentMonitorService.restoreCodexNativeSubAgentsFromReplay(threadId, next),
          ]);
        } catch (error) {
          backendRegistryLog.warn("codex transcript metadata repair failed", {
            threadId, error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }).finally(() => {
      this.transcriptRepairs.delete(threadId);
      const latest = this.pendingTranscriptRepairReplays.get(threadId);
      this.pendingTranscriptRepairReplays.delete(threadId);
      if (latest && !this.closed) this.scheduleTranscriptRepairs(threadId, latest);
    });
    this.transcriptRepairs.set(threadId, repair);
  }

  private async readThreadData(
    request: AppServerReadThreadRequest
  ): Promise<AppServerReadThreadResponse> {
    this.assertNotBootstrap("readThread");
    const readStartedAt = performance.now();
    const backend = request.backend ?? "codex";
    if (backend === "claude") {
      const subAgent = parseClaudeSubAgentTranscriptThreadId(request.threadId);
      if (subAgent) {
        // A sub-agent's transcript is read-only: no reviews, origins or requests.
        const replay = pageNormalizedReplay(
          await this.claudeBackend.readSubAgentTranscript(subAgent.parentThreadId, subAgent.taskId),
          { ...request, backend },
        );
        return { backend, threadId: request.threadId, fetchedAt: Date.now(), replay, threadStatus: replay.threadStatus };
      }
      const storedReplay = await this.claudeBackend.readThread(request.threadId);
      // Every review imports, not only the requested page's, so a review
      // older than the newest page still reaches To-dos. An older-page read
      // has nothing to add to the latest read's import.
      if (request.before === undefined) {
        this.threadTodoHandler?.importReviews?.({ backend, threadId: request.threadId },
          storedReplay.entries.filter((entry): entry is AppServerThreadReviewEntry => entry.type === "review"));
      }
      // PwrAgent's Claude transcript is read whole, so cut the requested page
      // here, as for ACP. Without a page the renderer has no older history to
      // ask for when its copy of the thread is missing some.
      const pagedReplay = pageNormalizedReplay(storedReplay, { ...request, backend });
      const messageIds = pagedReplay.messages.flatMap((message) =>
        message.role === "user" ? [message.id] : [],
      );
      const origins = await this.overlayStore.readThreadMessageOrigins?.({
        backend,
        threadId: request.threadId,
        messageIds,
      }) ?? {};
      const replay = mergeThreadMessageOrigins(pagedReplay, origins);
      const pendingRequest = this.getPendingRequestForThread({ backend, threadId: request.threadId });
      return { backend, threadId: request.threadId, fetchedAt: Date.now(), replay, pendingRequest, threadStatus: replay.threadStatus };
    }
    if (isAcpBackendId(backend)) {
      const response = await this.readAcpThread(request, backend);
      this.threadTodoHandler?.importReviews?.({ backend, threadId: request.threadId },
        response.replay.entries.filter((entry): entry is AppServerThreadReviewEntry => entry.type === "review"));
      return {
        ...response,
        replay: request.includeTurns === false
          ? response.replay
          : anchorReplayTurnUsage(this.correspondenceStore.appendToReplay(
              { backend, threadId: request.threadId },
              response.replay,
              undefined,
              response.pricing?.lines.flatMap((line) => line.scope === "turn" && line.turnId
                ? [{ id: line.turnId, startedAt: line.startedAt, completedAt: line.completedAt }] : []),
              { before: request.before, limit: request.limit },
            )),
        readDurationMs: Math.max(0, Math.round(performance.now() - readStartedAt)),
      };
    }

    const codexStatusObservationSequence =
      this.reserveCodexThreadStatusObservationSequence();

    const replay = await this.withCodexThreadClient(
      request.threadId,
      async (client) =>
        await client.readThread({
          threadId: request.threadId,
          includeTurns: request.includeTurns,
          before: request.before,
          limit: request.limit,
        }),
      // Reads are execution-mode-agnostic; skip the routing diagnostic so
      // content search (one readThread per thread) doesn't spew it.
      undefined,
      false,
    );
    this.reconcileBackendCodexThreadStatus(
      request.threadId,
      replay.threadStatus,
      codexStatusObservationSequence,
    );

    if (
      backend === "codex" &&
      !request.viewOnly &&
      !request.before &&
      request.includeTurns !== false
    ) {
      // Navigation repairs publish their own updates. Neither directory
      // discovery nor native-worker metadata is needed to render this replay.
      // Retain/drain the work so shutdown cannot close its store underneath it.
      this.scheduleTranscriptRepairs(request.threadId, replay);
    }

    const overlay = await this.overlayStore.getThreadOverlayState({
      backend,
      threadId: request.threadId,
    });
    const shouldAppendTranscriptOverlays = request.includeTurns !== false;
    const replayWithEnvironment = shouldAppendTranscriptOverlays
      ? appendCodexEnvironmentSetupActivity({
          replay,
          runtime: overlay?.codexEnvironmentRuntime,
        })
      : replay;
    const replayWithManagedReviews =
      request.before || !shouldAppendTranscriptOverlays
        ? replayWithEnvironment
        : mergeManagedReviewEntries({
            replay: replayWithEnvironment,
            entries: overlay?.managedReviewEntries,
          });
    // Usage merges into an older pagination page too. It is turn-anchored, so
    // a page only ever receives usage for turns it actually carries, and the
    // reader sees each row beside its own turn as history loads. Managed
    // reviews above stay on the live page: they originate a turn rather than
    // annotate one, so they have no anchor to page against.
    const replayWithImmutableUsage = shouldAppendTranscriptOverlays
      ? mergeTurnAnchoredUsageActivities({
          replay: replayWithManagedReviews,
          activities: (await this.threadUsageLedger.readThreadUsageActivities(backend, [request.threadId]))[request.threadId],
        })
      : replayWithManagedReviews;
    const messageIds = [
      ...replayWithImmutableUsage.entries.flatMap((entry) =>
        entry.type === "message" && entry.role === "user"
          ? [
              entry.id,
              ...(entry.turn?.id
                ? [buildTurnUserMessageOriginId(entry.turn.id)]
                : []),
            ]
          : [],
      ),
      ...replayWithImmutableUsage.messages.flatMap((message) =>
        message.role === "user" ? [message.id] : [],
      ),
    ];
    const persistedMessageOrigins =
      typeof this.overlayStore.readThreadMessageOrigins === "function"
        ? await this.overlayStore.readThreadMessageOrigins({
            backend,
            threadId: request.threadId,
            messageIds,
          })
        : {};
    let messageOrigins = { ...persistedMessageOrigins };
    const firstUserMessage = replayWithImmutableUsage.entries.find(
      (entry) => entry.type === "message" && entry.role === "user",
    );
    if (
      overlay?.handoffOrigin
      && replayWithImmutableUsage.pagination.hasPreviousPage === false
      && firstUserMessage?.type === "message"
      && !messageOrigins[firstUserMessage.id]
    ) {
      messageOrigins[firstUserMessage.id] = {
        kind: "agent",
        sourceThread: {
          backend: overlay.handoffOrigin.sourceBackend,
          threadId: overlay.handoffOrigin.sourceThreadId,
          ...(overlay.handoffOrigin.sourceTitle
            ? { title: overlay.handoffOrigin.sourceTitle }
            : {}),
        },
      };
    }
    // Review and task-monitor cards only. Gate cards are most of a busy
    // thread's history and neither helper below can match one.
    const transcriptCards = await this.overlayStore.listThreadSubAgents({
      backend,
      threadId: request.threadId,
      excludeTokenMiser: true,
    });
    messageOrigins = inferLegacyTaskMonitorMessageOrigins({
      origins: messageOrigins,
      replay: replayWithImmutableUsage,
      subAgents: transcriptCards,
    });
    const replayWithMessageOrigins = mergeThreadMessageOrigins(
      replayWithImmutableUsage,
      messageOrigins,
    );
    const replayWithReviewMetadata = attachReviewEntryMetadata({
      replay: replayWithMessageOrigins,
      subAgents: transcriptCards,
    });
    this.threadTodoHandler?.importReviews?.({ backend, threadId: request.threadId },
      replayWithReviewMetadata.entries.filter((entry): entry is AppServerThreadReviewEntry => entry.type === "review"));
    if (!request.viewOnly && !request.before && shouldAppendTranscriptOverlays) {
      // Hydration supersedes live rows for the same turn in sqlite. Preserve
      // that ordering now that live observations are delayed in memory: first
      // let every already-arrived usage emit derive and buffer its row, then
      // flush the batch before hydration marks those rows superseded. Without
      // this boundary, the delayed live insert lands afterward and both rows
      // remain active in pricing.
      await listingDiagnostics.trace("workflow", { query: "usage-durability" }, async () => {
        await this.threadUsageLedger.waitForLiveThreadUsageEmitWork({ backend, threadId: request.threadId });
        await this.threadUsageLedger.flushLiveThreadUsageLines({ durabilityOnly: true });
        await this.threadUsageLedger.persistReplayUsageLines(replayWithEnvironment);
      });
    }
    const includeAccounting = request.includeAccounting !== false;
    const pricing = includeAccounting
      ? await this.threadUsageLedger.readThreadPricingWithLiveTokenMiser({
          backend,
          threadId: request.threadId,
        })
      : undefined;
    const storedToolAccounting =
      includeAccounting
      && typeof this.overlayStore.readThreadToolAccounting === "function"
        ? await this.overlayStore.readThreadToolAccounting({
            backend,
            ...(request.includeAllToolInvocations
              ? { includeAllInvocations: true }
              : {}),
            threadId: request.threadId,
          })
        : undefined;
    const toolAccounting = storedToolAccounting
      ? await this.threadUsageLedger.withTokenMiserAccounting({
          accounting: storedToolAccounting,
          backend,
          threadId: request.threadId,
        })
      : undefined;
    const tokenMiserOverride = await this.resolveTokenMiserThreadOverride(
      backend,
      request.threadId,
    );
    const pendingRequest = this.getPendingRequestForThread({
      backend,
      threadId: request.threadId,
    });
    const tokenMiserEnabled = this.resolveTokenMiserEnabledForOverride(
      tokenMiserOverride,
    );

    return {
      backend,
      fetchedAt: Date.now(),
      readDurationMs: Math.max(0, Math.round(performance.now() - readStartedAt)),
      threadId: request.threadId,
      tokenMiserEnabled,
      ...(overlay?.tokenMiserEnabled !== undefined
        ? { tokenMiserOverride: overlay.tokenMiserEnabled }
        : {}),
      ...(pricing ? { pricing } : {}),
      ...(toolAccounting ? { toolAccounting } : {}),
      ...(pendingRequest ? { pendingRequest } : {}),
      ...(replayWithReviewMetadata.threadStatus
        ? { threadStatus: replayWithReviewMetadata.threadStatus }
        : {}),
      replay: request.includeTurns === false
        ? replayWithReviewMetadata
        : anchorReplayTurnUsage(this.correspondenceStore.appendToReplay(
            { backend, threadId: request.threadId },
            replayWithReviewMetadata,
            undefined,
            // Without the ledger, the replay's own turns and the store's
            // remembered timings still place correspondence.
            pricing?.lines.flatMap((line) => line.scope === "turn" && line.turnId
              ? [{ id: line.turnId, startedAt: line.startedAt, completedAt: line.completedAt }] : []),
            { before: request.before, limit: request.limit },
          )),
    };
  }

  async readUsageActivity(request: ReadUsageActivityRequest): Promise<ReadUsageActivityResponse> {
    if (!this.overlayStore.readUsageActivity) throw new Error("Usage ledger unavailable.");
    const activity = await this.overlayStore.readUsageActivity(request);
    const codex = this.codexLimitObservation();
    return { ...activity,
      // Navigation indexing can lag a live thread or rename. The information
      // store retains titles independently of query caches; consult it on the
      // owner before relaying rows over local IPC or federation. Durable titles
      // still name historical threads this process has never observed.
      rows: activity.rows.map((row) => ({
        ...row,
        title: this.getThreadInfo({
          backend: row.line.backend as AppServerBackendKind, threadId: row.line.threadId,
        })?.title ?? row.title,
      })),
      readAt: Date.now(),
      rateLimits: this.planLimits.limits("codex") ?? [],
      limitObservation: codex,
      // Older viewers chart every `limitHistory` reading as a Codex account.
      limitHistory: activity.limitHistory.filter(isCodexLimitObservation),
      limitObservations: [
        ...codex ? [{ ...codex, provider: "openai" }] : [],
        ...this.providerLimitObservations(),
      ],
      providerLimitHistory: activity.limitHistory.filter((reading) => !isCodexLimitObservation(reading)),
      analysisModelBackends: USAGE_ANALYSIS_MODEL_BACKENDS.filter((backend) =>
        backend === "codex" || hasAcpStructuredHelper(backend)) };
  }

  /**
   * A Codex thread on a configured model provider records usage under that
   * provider: its own account and rates, never the OpenAI login or catalog.
   * Returns undefined for every other line so it is written unchanged.
   */
  private attributeCodexProviderUsage(
    line: ThreadUsageLineRecord,
  ): Promise<ThreadUsageLineRecord> | undefined {
    if (line.backend !== "codex") return undefined;
    const providerId = (line.model ? parseCodexProviderModelId(line.model).providerId : undefined)
      ?? this.codexClient.modelProviderForThread?.(line.threadId);
    if (!providerId) return undefined;
    const provider = this.resolveCodexModelProvidersFn().find((entry) => entry.id === providerId);
    if (!provider) return undefined;
    // Keys are decrypted once and kept until one changes, not per write.
    this.codexModelProviderKeysRead ??= this.resolveCodexModelProviderKeysFn()
      .catch((): Record<string, string> => ({}));
    return this.codexModelProviderKeysRead.then((keys) => attributeCodexProviderUsageLine(
      line,
      provider,
      codexModelProviderAccountKey(provider.baseUrl, keys[provider.id]),
    ));
  }

  private codexModelProviderKeysRead?: Promise<Record<string, string>>;

  private async captureUsageAccount(backend: AppServerBackendKind, threadId?: string): Promise<string | undefined> {
    // Read the group synchronously: editing Settings during an in-flight turn
    // must affect the next request, never this one.
    try {
      const group = this.resolveUsageAccountGroupsFn()[backend];
      // Claude names its own account; an operator's group still wins.
      if (!group && backend === "claude") return await this.claudeBackend.usageAccountKey(threadId);
      if (group || backend !== "codex") return usageAccountKey(undefined, group);
      const account = this.codexClient.readAccount
        ? await this.codexClient.readAccount()
        : this.codexBackendSummary?.account;
      if (this.codexBackendSummary
        && usageAccountKey(this.codexBackendSummary.account) !== usageAccountKey(account)) {
        this.codexBackendSummary = { ...this.codexBackendSummary, account };
        this.forgetCodexAccountRateLimits();
      }
      return usageAccountKey(account);
    } catch {
      // Identity/configuration failures must not prevent accounting. A cached
      // login can belong to a different
      // account after a switch or failed authentication refresh.
      return undefined;
    }
  }

  /**
   * The account changed: drop its limits. Clearing the store also drops every
   * quota read already in flight, so the old account's reply cannot return
   * under its old key.
   */
  private forgetCodexAccountRateLimits(): void {
    this.codexAccountRevision += 1;
    this.planLimits.clear("codex");
  }

  /** Account limits from providers other than Codex, each with its ledger provider. */
  private providerLimitObservations(): UsageLimitObservation[] {
    return PROVIDER_LIMIT_BACKENDS.flatMap((backend) => this.providerLimitObservation(backend) ?? []);
  }

  /** One non-Codex backend's account limits, keyed as its turns' account is. */
  private providerLimitObservation(backend: AppServerBackendKind): UsageLimitObservation | undefined {
    const reading = backend === "claude" ? this.claudeBackend.limitObservation()
      : isAcpBackendId(backend) ? this.acpBackend.limitObservation?.(backend) : undefined;
    if (!reading) return undefined;
    let group: string | undefined;
    try { group = this.resolveUsageAccountGroupsFn()[backend]; } catch { /* The reading keeps its own key. */ }
    // An operator's Account group names the account its turns record, so the
    // reading takes the same key and joins their history, as Codex's does.
    const accountKey = usageAccountKey(undefined, group);
    return accountKey ? { ...reading, accountKey } : reading;
  }

  /** The reading a provider's finished turn records, when it describes that turn's account. */
  private turnLimitObservation(backend: AppServerBackendKind): UsageLimitObservation | undefined {
    return backend === "codex" ? this.codexLimitObservation() : this.providerLimitObservation(backend);
  }

  /**
   * The Codex account limits this instance holds, keyed by an opaque account
   * hash so owners on different accounts never blend and no email is relayed.
   */
  private codexLimitObservation(): UsageLimitObservation | undefined {
    const summary = this.codexBackendSummary;
    const reading = this.planLimits.snapshot("codex");
    const observedAt = reading?.observedAt;
    if (!summary || !reading?.limits.length || observedAt === undefined) return undefined;
    const account = summary.account;
    return {
      observedAt,
      accountKey: reading.account,
      planType: account?.planType,
      limits: reading.limits.map((limit) => ({
        name: limit.name, limitId: limit.limitId, windowKey: limit.windowKey,
        usedPercent: limit.usedPercent, used: limit.used, limit: limit.limit,
        resetAt: limit.resetAt, windowMinutes: limit.windowMinutes,
        hasCredits: limit.hasCredits, unlimited: limit.unlimited,
      })),
    };
  }

  async analyzeUsageActivity(request: AnalyzeUsageActivityRequest): Promise<AnalyzeUsageActivityResponse> {
    this.assertNotBootstrap("analyzeUsageActivity");
    const modelBackend = usageAnalysisModelBackend(request);
    const read = (params: AppServerReadThreadRequest) => this.readThread(params);
    if (modelBackend === "codex") {
      if (!this.codexClient.generateStructuredObject) throw new Error("Codex analysis unavailable on this instance.");
      return await analyzeUsageActivity(request, read, (params) => this.codexClient.generateStructuredObject!({
        ...params,
        helper: "usage_analysis",
      }));
    }
    // An ACP agent answers in a tool-less session on a process of its own,
    // which it forgets afterwards; see acp-structured-generation.ts.
    // The effort for the model that runs: the picked one, checked against
    // its own catalog entry, never a fallback the resolver would choose.
    const acpSelection = (model: string) => {
      const entry = this.acpBackend.getLaunchpadOptions(modelBackend)?.models
        ?.find((candidate) => candidate.id === model);
      return resolveHelperModel({
        helper: "usage_analysis",
        backend: modelBackend,
        settings: this.resolveHelperModelSettingsFn(),
        models: entry ? [entry] : [],
        requestedModel: model,
      });
    };
    return await analyzeUsageActivity(request, read, async (params) => await generateAcpStructuredObject({
      backend: modelBackend,
      cwd: await this.resolveAcpHelperWorkspace(),
      run: (prompt) => this.acpBackend.runEphemeralPrompt(modelBackend, prompt),
      model: params.model, reasoningEffort: acpSelection(params.model).reasoningEffort,
      system: params.system, prompt: params.prompt,
      schema: params.schema, isMatch: params.isMatch, turnTimeoutMs: params.turnTimeoutMs,
    }));
  }

  async inspectTokenMiserOutput(
    request: InspectTokenMiserOutputRequest,
  ): Promise<InspectTokenMiserOutputResponse> {
    if (request.backend !== "codex" || !this.tokenMiserStore) return { available: false };
    return await this.tokenMiserStore.inspectOutput(request);
  }

  async analyzeThreadToolHistory(
    request: AnalyzeThreadToolHistoryRequest,
  ): Promise<AnalyzeThreadToolHistoryResponse> {
    this.assertNotBootstrap("analyzeThreadToolHistory");
    if (typeof this.overlayStore.persistThreadToolHistoryAnalysis !== "function") {
      throw new Error("Tool-output history analysis storage is unavailable.");
    }

    const scanStartedAt = performance.now();
    const pages: AppServerThreadReplay[] = [];
    const seenCursors = new Set<string>();
    let before: string | undefined;
    let complete = false;
    for (let page = 0; page < 1_000; page += 1) {
      let response: AppServerReadThreadResponse;
      try {
        response = await this.readThread({
          backend: request.backend,
          ...(before ? { before } : {}),
          limit: 100,
          threadId: request.threadId,
          viewOnly: true,
        });
      } catch (error) {
        if (pages.length === 0) {
          throw error;
        }
        break;
      }
      pages.push(response.replay);
      if (!response.replay.pagination.hasPreviousPage) {
        complete = true;
        break;
      }
      const cursor = response.replay.pagination.previousCursor;
      if (!cursor || seenCursors.has(cursor)) {
        break;
      }
      seenCursors.add(cursor);
      before = cursor;
    }

    /* Phase timings, because "is this well behaved on the main process" is a
       measurement and not an argument. The paging loop awaits between pages
       so it yields; the two phases below do not, and each is one
       uninterrupted block on the process every window's IPC shares.
       `analyzeMs` normalizes every entry of every page in one pass;
       `persistMs` writes every invocation through better-sqlite3, which is
       synchronous. Whichever is larger is the one worth moving. */
    const pagesMs = Math.round(performance.now() - scanStartedAt);
    const analyzeStartedAt = performance.now();
    const analysis = analyzeNormalizedToolReplay({
      backend: request.backend,
      complete,
      largeOutputThresholdChars: toolOutputWarningChars(
        this.toolOutputAlertPolicy.repeatedLargeOutputMinimumPercent,
      ),
      pages,
      threadId: request.threadId,
    });
    const analyzeMs = Math.round(performance.now() - analyzeStartedAt);
    const persistStartedAt = performance.now();
    await this.overlayStore.persistThreadToolHistoryAnalysis({
      backend: request.backend,
      coverage: analysis.coverage,
      invocations: analysis.invocations,
      threadId: request.threadId,
    });
    const persistMs = Math.round(performance.now() - persistStartedAt);
    const readbackStartedAt = performance.now();
    const storedAccounting = await this.overlayStore.readThreadToolAccounting({
      backend: request.backend,
      includeAllInvocations: true,
      threadId: request.threadId,
    });
    const accounting = await this.threadUsageLedger.withTokenMiserAccounting({
      accounting: storedAccounting,
      backend: request.backend,
      threadId: request.threadId,
    });
    const readbackMs = Math.round(performance.now() - readbackStartedAt);
    /* Info, not debug: this is the number that decides whether the scan needs
       to move off the main process, and it should not require a dev build to
       read. One line per scan, and a scan is operator-initiated. */
    backendRegistryLog.info("analyzeThreadToolHistory:timing", {
      analyzeMs,
      complete,
      entryCount: analysis.coverage.entryCount,
      invocationCount: analysis.coverage.invocationCount,
      pageCount: pages.length,
      pagesMs,
      persistMs,
      readbackMs,
      totalMs: Math.round(performance.now() - scanStartedAt),
    });
    await this.threadUsageLedger.emitThreadToolAccountingUpdated({
      backend: request.backend,
      threadId: request.threadId,
    });
    return { accounting, coverage: analysis.coverage };
  }

  /**
   * One finished turn's replay, for work that needs only that turn, such as a
   * messaging reply's images. It reads no transcript page, overlay, or
   * accounting. Answers undefined when the backend cannot read one turn.
   */
  async readThreadTurnReplay(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): Promise<AppServerThreadReplay | undefined> {
    if (params.backend !== "codex") {
      return undefined;
    }
    this.assertNotBootstrap("readThreadTurnReplay");
    // A read does not depend on the execution mode; naming one skips the
    // overlay parse that would otherwise pick it.
    return await this.withCodexThreadClient(
      params.threadId,
      async (client) => await client.readThreadTurn?.({
        threadId: params.threadId,
        turnId: params.turnId,
      }),
      "default",
      false,
    );
  }

  async getThreadTranscriptImageRoots(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<string[]> {
    this.assertNotBootstrap("getThreadTranscriptImageRoots");
    const [thread, overlay] = await Promise.all([
      this.findThreadForWorkspaceHandoff({
        backend: params.backend,
        callerReason: "transcript-image-roots",
        freshness: "last-known",
        threadId: params.threadId,
      }),
      this.overlayStore.getThreadOverlayState({
        backend: params.backend,
        threadId: params.threadId,
      }),
    ]);
    const roots = new Set<string>();
    for (const directory of dedupeLinkedDirectoriesByNormalizedIdentity([
      ...(thread?.linkedDirectories ?? []),
      ...(overlay?.extraLinkedDirectories ?? []),
    ])) {
      for (const candidate of [directory.path, directory.worktreePath]) {
        const trimmed = candidate?.trim();
        if (trimmed) {
          roots.add(path.resolve(trimmed));
        }
      }
    }

    return [...roots];
  }

  withLiveTokenMiserNavigationSnapshot(
    snapshot: NavigationSnapshot,
  ): NavigationSnapshot {
    return this.threadUsageLedger.withLiveTokenMiserNavigationSnapshot(snapshot);
  }

  listLiveTokenMiserSubAgents(
    threadId: string,
  ): ThreadSubAgentSummary[] {
    return this.threadUsageLedger.listLiveTokenMiserSubAgents(threadId);
  }

  readLiveSubAgentRevisionSource(
    threadId: string,
  ): unknown {
    return this.threadUsageLedger.readLiveSubAgentRevisionSource(threadId);
  }

  mergeLiveTokenMiserSubAgents(
    threadId: string,
    persisted: readonly ThreadSubAgentSummary[] | undefined,
  ): ThreadSubAgentSummary[] {
    return this.threadUsageLedger.mergeLiveTokenMiserSubAgents(threadId, persisted);
  }

  /**
   * Keep a newly created thread visible when its directory's unpinned section
   * is collapsed. This runs after parent and directory relationships are
   * persisted so every creation surface shares the same policy and a child of
   * an already-visible parent is never pinned itself.
   */
  private resolveCreatedThreadDirectoryVisibility(params: {
    directoryKey?: string;
    cwd?: string;
    linkedDirectories?: LinkedDirectorySummary[];
  }): CreatedThreadDirectoryVisibility | undefined {
    const explicitDirectory = params.directoryKey
      ? this.createdThreadDirectoryVisibility.get(params.directoryKey)
      : undefined;
    if (explicitDirectory) {
      return explicitDirectory;
    }

    const normalizePath = (value?: string): string | undefined => {
      const normalized = value?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
      return normalized || undefined;
    };
    const candidatePaths = new Set(
      [
        ...(params.linkedDirectories ?? []).map((directory) => directory.path),
        params.cwd,
      ]
        .map(normalizePath)
        .filter((value): value is string => Boolean(value)),
    );
    const directories = [...this.createdThreadDirectoryVisibility.values()];
    for (const candidatePath of candidatePaths) {
      const exact = directories.find(
        (directory) => normalizePath(directory.path) === candidatePath,
      );
      if (exact) {
        return exact;
      }
    }

    return directories
      .filter((directory) => directory.kind === "workspace")
      .sort(
        (left, right) =>
          (normalizePath(right.path)?.length ?? 0)
          - (normalizePath(left.path)?.length ?? 0),
      )
      .find((directory) => {
        const directoryPath = normalizePath(directory.path);
        return Boolean(
          directoryPath
          && [...candidatePaths].some((candidatePath) =>
            candidatePath.startsWith(`${directoryPath}/`),
          ),
        );
      });
  }

  /**
   * The row this directory renders top-level for `threadId`'s group, or
   * `undefined` when the directory renders no such row — a parent on a peer,
   * in another project, or outside the navigation window all land here, and a
   * new child of one of those is top-level in this directory itself.
   */
  private resolveCreatedThreadVisibilityAncestor(params: {
    backend: AppServerBackendKind;
    directory: CreatedThreadDirectoryVisibility;
    threadId: string;
  }): CreatedThreadVisibilityRow | undefined {
    const rows = params.directory.rowsByThreadKey;
    // A creation request names its parent by backend and id, but a peer-owned
    // row is filed under its federated key. Translate before the lookup, or
    // every remote parent reads as "not rendered here" and its child takes a
    // pin it cannot show a control for.
    const localKey = buildThreadIdentityKey(params.backend, params.threadId);
    let key = params.directory.rowKeysByLocalKey.get(localKey) ?? localKey;
    let row = rows.get(key);
    const seen = new Set<string>();
    while (row?.parentKey && !seen.has(key)) {
      seen.add(key);
      const parent = rows.get(row.parentKey);
      // A parent link this directory does not render leaves the current row
      // as the group's top-level row.
      if (!parent) break;
      key = row.parentKey;
      row = parent;
    }
    return row;
  }

  /**
   * Make a group's top-level row show the child that was just created: pin the
   * row when the collapse would hide it, and open its sub-thread tray when the
   * operator had it closed. Mirrors what the renderer already does when it
   * inserts a child from the sidebar, so both creation paths leave the same
   * state behind.
   */
  private async revealCreatedThreadGroup(params: {
    ancestor: CreatedThreadVisibilityRow;
    directory: CreatedThreadDirectoryVisibility;
  }): Promise<Pick<StartThreadResponse, "pinnedRank" | "autoPinFailure">> {
    const { ancestor } = params;
    if (ancestor.pinned && !ancestor.subthreadsCollapsed) {
      return {};
    }
    if (ancestor.remote) {
      // This row belongs to a peer: its pin lives in `remote_thread_pins` and
      // its collapse is the owner's state, so both mutators below would write
      // a local overlay nothing renders. Leave the group alone rather than
      // fabricate one — and never fall through to pinning the child, which is
      // a nested row either way.
      logDebug("createdThreadVisibility:remoteGroupSkipped", {
        directoryKey: params.directory.key,
        threadId: ancestor.threadId,
      });
      return {};
    }
    try {
      if (ancestor.subthreadsCollapsed) {
        await this.overlayStore.setSubthreadsCollapsed?.({
          backend: ancestor.backend,
          parentThreadId: ancestor.threadId,
          collapsed: false,
        });
        await this.emit({
          backend: ancestor.backend,
          notification: {
            method: "thread/subthreadsCollapsed/updated",
            params: {
              parentThreadId: ancestor.threadId,
              collapsed: false,
            },
          },
        });
      }
      if (!ancestor.pinned) {
        await this.createdThreadVisibilityLock.run(
          "global-pin-order",
          async () => {
            const pinnedRank = await this.buildCreatedThreadVisibilityPinRank();
            await this.overlayStore.setThreadPin({
              backend: ancestor.backend,
              threadId: ancestor.threadId,
              pinnedRank,
            });
            await this.emit({
              backend: ancestor.backend,
              notification: {
                method: "thread/pin/added",
                params: {
                  threadId: ancestor.threadId,
                  pinnedRank,
                },
              },
            });
            this.createdThreadVisibilityPinnedRanks.push(pinnedRank);
          },
        );
      }
      logDebug("createdThreadVisibility:groupRevealed", {
        directoryKey: params.directory.key,
        threadId: ancestor.threadId,
      });
      return {};
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      backendRegistryLog.warn("created thread group reveal failed", {
        backend: ancestor.backend,
        error: detail,
        threadId: ancestor.threadId,
      });
      return {
        autoPinFailure: {
          message:
            `The new thread was created, but its group could not be revealed automatically: ${detail}`,
        },
      };
    }
  }

  /**
   * The next rank at the TOP of the operator's pin list: the thread was just
   * created, so it is the one the operator is about to look for, and the
   * bottom of a long pin list is the least visible place to put it. Remote
   * rows pinned into this viewer's main window own ranks in
   * `remote_thread_pins`, not the local thread overlay, and new local pins
   * join the same user-curated order,
   * so rank allocation must include both stores or it can reuse a remote rank
   * and strand the two rows at the local/remote boundary.
   */
  private async buildCreatedThreadVisibilityPinRank(): Promise<string> {
    let remotePinnedRanks: Array<string | undefined> = [];
    try {
      remotePinnedRanks =
        typeof this.overlayStore.listRemoteThreadPins === "function"
          ? (await this.overlayStore.listRemoteThreadPins())
              .map((pin) => pin.localPinnedRank)
          : [];
    } catch (error) {
      // Visibility is an enhancement. A read failure should not turn a
      // successfully created thread into a failed creation response.
      backendRegistryLog.warn("remote pin ranks unavailable during auto-pin", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return buildPrependPinRank([
      ...this.createdThreadVisibilityPinnedRanks,
      ...remotePinnedRanks,
    ]);
  }

  private async finalizeCreatedThreadVisibility(params: {
    backend: AppServerBackendKind;
    directoryKey?: string;
    cwd?: string;
    linkedDirectories?: LinkedDirectorySummary[];
    parentThreadBackend?: AppServerBackendKind;
    parentThreadId?: string;
    threadId: string;
  }): Promise<Pick<StartThreadResponse, "pinnedRank" | "autoPinFailure">> {
    const directory = this.resolveCreatedThreadDirectoryVisibility(params);
    if (!directory?.hasPinnedTopLevelThread) {
      return {};
    }
    if (!directory.directoryThreadsCollapsed) {
      // With only pins left, Directory threads has no disclosure to close.
      // Treat that empty section as closed too. A refresh may already include
      // this creation; it must not count as pre-existing unpinned overflow.
      for (const row of directory.rowsByThreadKey.values()) {
        if (!row.parentKey && !row.pinned
          && (row.remote || row.backend !== params.backend || row.threadId !== params.threadId)) {
          return {};
        }
      }
    }

    // A sub-thread renders inside its group, so what has to be visible is the
    // group, not the child. Pinning the child instead would put a `pinnedRank`
    // on a row `ThreadRow` refuses to show a pin control for — an unremovable
    // pin while the parent renders, and a top-level row the operator never
    // pinned as soon as it does not. So walk to the top-level ancestor and
    // make *that* row show its tray.
    const parentThreadId = params.parentThreadId?.trim();
    const ancestor = parentThreadId
      ? this.resolveCreatedThreadVisibilityAncestor({
          backend: params.parentThreadBackend ?? params.backend,
          directory,
          threadId: parentThreadId,
        })
      : undefined;
    if (ancestor) {
      return await this.revealCreatedThreadGroup({ ancestor, directory });
    }

    // No ancestor this directory renders — the new thread is a top-level row
    // here, so it is the row that needs the pin.
    return await this.createdThreadVisibilityLock.run("global-pin-order", async () => {
      const pinnedRank = await this.buildCreatedThreadVisibilityPinRank();
      try {
        await this.overlayStore.setThreadPin({
          backend: params.backend,
          threadId: params.threadId,
          pinnedRank,
        });
        await this.emit({
          backend: params.backend,
          notification: {
            method: "thread/pin/added",
            params: {
              threadId: params.threadId,
              pinnedRank,
            },
          },
        });
        this.createdThreadVisibilityPinnedRanks.push(pinnedRank);
        return { pinnedRank };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const message =
          `The new thread was created, but it could not be pinned automatically: ${detail}`;
        backendRegistryLog.warn("created thread visibility finalization failed", {
          backend: params.backend,
          error: detail,
          threadId: params.threadId,
        });
        return { autoPinFailure: { message } };
      }
    });
  }

  async startThread(params: {
    backend: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
    cwd?: string;
    directoryKey?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    mcpConnectionIds?: string[];
    mcpProviderServersEnabled?: boolean;
    agent?: StartThreadRequest["agent"];
    acpRuntime?: BackendAcpSessionRuntimeState;
    workMode?: NavigationLaunchpadDraft["workMode"];
    branchName?: string;
    worktreeBranchMode?: BackendRegistryForkThreadRequest["worktreeBranchMode"];
    /** Base for a new worktree when `branchName` is unset. */
    worktreeBase?: WorktreeBaseSource;
    requiredWorkMode?: NavigationLaunchpadDraft["workMode"];
    parentThreadId?: string;
    parentThreadBackend?: AppServerBackendKind;
    parentThreadInstanceId?: string;
    prAutoDispatchEnabled?: boolean;
    tokenMiserEnabled?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    /**
     * Run the environment's setup in the new workspace even when it is not a
     * new worktree. A named environment has never run there.
     */
    rerunCodexEnvironmentSetup?: boolean;
    linkedDirectories?: LinkedDirectorySummary[];
  }): Promise<StartThreadResponse> {
    assertOwnerExecutionPolicy(getOwnerHostServices().runtimePolicy, params);
    return await listingDiagnostics.trace("workflow", { query: "thread-start" }, () => this.startThreadPrepared(params));
  }

  private async startThreadPrepared(params: Parameters<DesktopBackendRegistry["startThread"]>[0]): Promise<StartThreadResponse> {
    return await new ThreadCreationLifecycle().prepare(async (resources) => await this.prepareThreadCreation(params, resources), (stage, error) => {
      backendRegistryLog.warn("thread creation preparation cleanup failed", {
        backend: params.backend, stage, error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async prepareThreadCreation(params: Parameters<DesktopBackendRegistry["startThread"]>[0], resources: ThreadCreationPreparation): Promise<PreparedThreadCreation<Pick<StartThreadResponse, "executionMode" | "codexEnvironmentRuntime" | "codexEnvironmentStartupFailure">>> {
    this.assertThreadOwnership();
    this.assertNotBootstrap("startThread");
    const {
      backend,
      executionMode: requestedExecutionMode = "default",
      directoryKey,
      linkedDirectories,
      workMode,
      branchName,
      worktreeBranchMode,
      worktreeBase,
      requiredWorkMode,
      parentThreadId,
      parentThreadBackend,
      parentThreadInstanceId,
      prAutoDispatchEnabled,
      tokenMiserEnabled: tokenMiserOverride,
      mcpConnectionIds: requestedMcpConnectionIds,
      mcpProviderServersEnabled,
      rerunCodexEnvironmentSetup,
      ...request
    } = params;
    // A launchpad's access defaults to Auto for Codex and Claude. A Codex older
    // than 0.153.0 cannot run Auto, so start on Default Access instead of
    // sending a mode the runtime does not have.
    const executionMode = requestedExecutionMode === "auto"
      ? await this.downgradeUnavailableAutoExecutionMode(backend)
      : requestedExecutionMode;
    // Handoffs and messaging create threads without a launchpad. Apply the
    // profile defaults here too, while preserving an explicit empty selection.
    const mcpConnectionIds = requestedMcpConnectionIds
      ?? await this.threadMcpConnections.resolveNewThreadMcpConnectionIds();
    const modelSettings = await this.admitNewThreadModelSettings(backend, request);
    let cwd: string | undefined =
      !request.cwd?.trim()
        ? await this.createScratchProjectDirectory()
        : request.cwd;
    let resolvedLinkedDirectories = linkedDirectories;
    let effectiveWorkMode = workMode;
    if (workMode === "worktree" && request.cwd?.trim()) {
      const preparedWorkspace =
        await this.gitDirectoryService.prepareLaunchpadWorkspace({
          backend,
          branchName,
          directoryKind: "directory",
          directoryLabel: path.basename(request.cwd) || request.cwd,
          directoryPath: request.cwd,
          workMode: "worktree",
          ...(worktreeBranchMode ? { worktreeBranchMode, rejectOccupiedBranch: true } : {}),
          ...(worktreeBase ? { worktreeBase } : {}),
        });
      resources.setWorkspaceRollback(preparedWorkspace.rollback);
      cwd = preparedWorkspace.cwd;
      effectiveWorkMode = preparedWorkspace.workMode;
      resolvedLinkedDirectories =
        preparedWorkspace.workMode === "worktree"
          ? buildWorktreeLinkedDirectory({
              label: path.basename(request.cwd) || request.cwd,
              repositoryPath: preparedWorkspace.repositoryPath ?? request.cwd,
              worktreePath: preparedWorkspace.cwd,
            })
          : buildLocalLinkedDirectory(cwd);
    }
    if (requiredWorkMode && effectiveWorkMode !== requiredWorkMode) {
      await refuseResolvedWorkMode({
        required: requiredWorkMode,
        resolved: effectiveWorkMode,
        rollback: undefined,
        backend,
      });
    }
    let codexEnvironmentRuntime = request.codexEnvironmentRuntime;
    let codexEnvironmentStartupFailure: CodexEnvironmentStartupFailure | undefined;
    // Every provider runs the environment's setup in its own workspace: the
    // runtime's commands and captured shell environment are provider-neutral.
    if (request.codexEnvironmentRuntime && workMode) {
      try {
        codexEnvironmentRuntime = await this.threadDirectoryService.buildForkedCodexEnvironmentRuntime({
            cwd,
            forceSetup: rerunCodexEnvironmentSetup,
            sourceRuntime: request.codexEnvironmentRuntime,
            workMode: effectiveWorkMode ?? "local",
          });
      } catch (error) {
        if (error instanceof CodexEnvironmentStartupError) {
          codexEnvironmentRuntime = error.runtime;
          codexEnvironmentStartupFailure = {
            message: error.message,
            phase: error.phase,
            worktreeCleanupAvailable: effectiveWorkMode === "worktree",
          };
        } else {
          throw error;
        }
      }
    }

    const acpAgent = isAcpBackendId(backend)
      ? this.acpBackend.getInstalledAgent(backend)
      : undefined;
    const acpRuntimeCapabilities = acpAgent?.runtimeCapabilities;
    const acpRuntimeStartedAt = Date.now();
    const acpRuntimeWithDefaults = isAcpBackendId(backend)
      ? mergeAcpRuntimeState(
          acpRuntimeModeDefaultsFromCapabilities(
            acpRuntimeCapabilities,
            acpRuntimeStartedAt,
          ),
          request.acpRuntime,
        )
      : request.acpRuntime;
    const acpRuntimeWithModel = isAcpBackendId(backend)
      ? withAcpModelRuntimeSelection({
          runtime: acpRuntimeWithDefaults,
          runtimeCapabilities: acpRuntimeCapabilities,
          model: modelSettings.model,
          reasoningEffort: modelSettings.reasoningEffort,
          now: acpRuntimeStartedAt,
        })
      : acpRuntimeWithDefaults;
    const effectiveExecutionMode =
      isAcpBackendId(backend) &&
      acpAgent?.registryId === "qwen" &&
      executionMode === "default" &&
      acpRuntimeStateRequiresFullAccess({
        runtime: acpRuntimeWithModel,
        runtimeCapabilities: acpRuntimeCapabilities,
      })
        ? "full-access"
        : executionMode;
    const modeSettings = executionModeSettings(effectiveExecutionMode);
    const acpRuntime = sanitizeAcpRuntimeForExecutionMode({
      backend,
      executionMode: effectiveExecutionMode,
      runtime: acpRuntimeWithModel,
    });
    const client = backend === "codex"
      ? this.getClient(backend, effectiveExecutionMode)
      : undefined;
    const tokenMiserEnabled = backend === "codex"
      && this.resolveTokenMiserEnabledForOverride(tokenMiserOverride);
    const runtimePreparation = resources.track(tokenMiserEnabled ? this.prepareTokenMiserRuntime() : Promise.resolve());
    const agentToolCatalogs = resolveAgentToolCatalogs({
      appManagementHandler: this.appManagementHandler,
      currentTurnInputSource: this.currentTurnInputSource,
      automationInspectionHandler: this.automationInspectionHandler,
      federationHandler: this.federationHandler,
      mcpGatewayTools: this.mcpGatewayTools,
      mcpConnectionHandler: async (request) =>
        await this.threadMcpConnections.handleAgentMcpConnectionRequest(request),
      messagingHandler: this.messagingHandler,
      messagingWorkingUpdatesHandler: this.messagingWorkingUpdatesHandler,
      taskMonitorHandler: async (request) =>
        await this.subAgentMonitorService.handleAgentTaskMonitorRequest(request),
      threadInspectionHandler: this.threadInspectionHandler,
      forgeReadHandler: this.forgeToolBridge.gatedForgeReadHandler,
      forgePrToolHandler: this.forgeToolBridge.gatedForgePrToolHandler,
      forgeToolPolicy: this.forgeToolBridge.resolveForgeToolPolicy(),
      threadOrchestrationHandler: this.threadOrchestrationHandler,
      // Gated on the setting, not merely on the store existing: the store is
      // constructed for any live Codex client, so passing it unconditionally
      // advertised three retrieval tools into every turn of an operator who
      // never enabled the feature.
      ...(tokenMiserEnabled ? { tokenMiserStore: this.tokenMiserStore, tokenMiserFocused: this.tokenMiserService?.focused } : {}),
      starMapHandler: this.starMapHandler,
      threadTodoHandler: this.threadTodoHandler,
      openAIDecisionsHandler: this.openAIDecisionsHandler,
      researchHandler: this.advertisedResearchHandler,
      checkoutHandler: this.checkoutHandler,
    });
    const pdfMcpPreparation = resources.track(
      backend === "codex" && this.resolvePdfAnalysisEnabledFn()
        ? this.registerPdfMcpClient({})
        : Promise.resolve(undefined));
    const connectionPreparation = resources.registerConnections(backend === "codex" || isAcpBackendId(backend)
      ? this.threadMcpConnections.registerMcpConnections(mcpConnectionIds, undefined, backend)
      : Promise.resolve([]));
    const isolateFromInherited = backend === "codex" && mcpProviderServersEnabled === false;
    const inventoryPreparation = resources.track(backend === "codex" && (mcpConnectionIds?.length || isolateFromInherited)
      ? this.threadMcpConnections.readConfiguredCodexMcpServerNames(cwd)
      : Promise.resolve(undefined));
    const resolvedDynamicTools =
      backend === "codex"
        ? withPwrAgentToolDiscovery(buildCodexParentDynamicToolSpecs(agentToolCatalogs), this.resolveCodexToolDiscoveryFn())
        : undefined;
    // Custom MCP servers can report READY without Codex exposing their tools
    // to the model. Keep the dynamic PDF surface as the compatible fallback.
    const dynamicTools = resolvedDynamicTools?.length
      ? resolvedDynamicTools
      : undefined;
    const [pdfMcpRegistration, mcpConnectionRegistrations, inheritedCodexMcpServerNames] = await joinConcurrent([
      pdfMcpPreparation, connectionPreparation, inventoryPreparation, runtimePreparation,
    ]);
    const pdfMcpConfig = pdfMcpRegistration
      ? buildCodexPdfMcpConfig(pdfMcpRegistration)
      : undefined;
    if (isolateFromInherited && inheritedCodexMcpServerNames === undefined) {
      throw codexMcpIsolationUnavailableError();
    }
    const connectionMcpConfig = buildCodexConnectionMcpConfig(
      mcpConnectionRegistrations,
      inheritedCodexMcpServerNames,
      { isolateFromInherited },
    );
    const tokenMiserConfig = client
      ? await this.buildSupportedCodexTokenMiserConfig({
          client,
          enabled: tokenMiserEnabled,
        })
      : undefined;
    const pwrdrvrTokenMiser = client
      ? await this.buildSupportedPwrdrvrTokenMiserActivation({
          client,
          enabled: tokenMiserEnabled,
        })
      : undefined;
    const codexThreadConfig = mergeCodexThreadConfigs(
      pdfMcpConfig,
      connectionMcpConfig,
      tokenMiserConfig,
    );
    const acpMcpRegistration = mcpConnectionRegistrations.length > 0
      ? {
          servers: mcpConnectionRegistrations.map(({ server }) => server),
          bindThread: async (threadId: string) => {
            for (const registration of mcpConnectionRegistrations) {
              registration.bindThread(threadId);
            }
          },
        }
      : undefined;
    if (dynamicTools?.length) {
      backendRegistryLog.info("attaching agent tool catalogs", {
        backend,
        catalogFingerprints: agentToolCatalogs.map(
          (catalog) => catalog.summary.fingerprint,
        ),
        catalogs: agentToolCatalogs.map((catalog) => catalog.id),
        toolCount: dynamicTools.length,
        tools: dynamicTools.map((tool) => tool.name),
      });
    }

    backendRegistryLog.info("startThread", {
      backend,
      cwd,
      executionMode,
      model: modelSettings.model ?? null,
      reasoningEffort: modelSettings.reasoningEffort ?? null,
      serviceTier: modelSettings.serviceTier ?? null,
      fastMode: modelSettings.fastMode ?? null,
    });

    const agentName = request.agent?.name?.trim();
    let gitBranch: string | undefined;
    let currentMigration: DesktopProviderThreadModelMigration | undefined;
    return { options: {
      backend,
      systemPlaceholder: !agentName,
      worktree: effectiveWorkMode === "worktree",
      tokenMiserOverride,
      pdfCatalog: Boolean(pdfMcpRegistration) && typeof this.overlayStore.setThreadMessagingPdfToolCatalogVersion === "function",
      mcpSelection: Boolean(mcpConnectionIds?.length) || mcpProviderServersEnabled === false,
      agent: Boolean(request.agent),
      environment: Boolean(codexEnvironmentRuntime),
      modelSettings,
      parent: Boolean(parentThreadId?.trim()),
    }, host: {
      providers: {
        claude: async () => await this.claudeBackend.startThread({ cwd: cwd!, executionMode: effectiveExecutionMode, model: modelSettings.model, linkedDirectories: resolvedLinkedDirectories }),
        acp: async () => await this.startAcpSession({
          backend: backend as AcpBackendId,
          cwd,
          executionMode: effectiveExecutionMode,
          acpRuntime,
          reasoningEffort: modelSettings.reasoningEffort,
          mcpRegistration: acpMcpRegistration,
        }),
        codex: async () => await (
            client ?? this.getClient(backend, effectiveExecutionMode)
          ).startThread({
            ...request,
            ...modelSettings,
            cwd,
            approvalPolicy: request.approvalPolicy ?? modeSettings.approvalPolicy,
            approvalsReviewer: modeSettings.approvalsReviewer,
            sandbox: ownerSandboxForMode(getOwnerHostServices().runtimePolicy, effectiveExecutionMode, request.sandbox, modeSettings.sandbox),
            codexEnvironmentRuntime,
            ...(backend === "codex"
              ? {
                  defaultModeRequestUserInput:
                    this.resolveCodexDefaultModeRequestUserInputFn(),
                  developerInstructions: providerDeliveredAgentInstructions(request.agent),
                  threadSource: "user" as CodexThreadSource,
                  ...(codexThreadConfig ? { config: codexThreadConfig } : {}),
                  ...(pwrdrvrTokenMiser
                    ? { pwrdrvrTokenMiser }
                    : {}),
                }
              : {}),
            dynamicTools,
          }),
      },
      withWorkspaceWrite: async (submit) => await this.withArchiveWorkspaceWrite(
        [cwd ?? "", ...(resolvedLinkedDirectories ?? []).map((directory) => linkedDirectoryWorktreePath(directory) ?? directory.path)], submit,
      ),
      rejection: (error) => userActionableMcpConnectionConfigError(error, mcpConnectionRegistrations),
      bindPdf: ({ threadId }) => { pdfMcpRegistration?.bindThread(threadId); },
      rememberPending: async ({ threadId }) => {
        const startedAt = Date.now();
        const pendingThreadKey = buildThreadIdentityKey(backend, threadId);
        gitBranch = cwd ? await readCurrentGitBranch(cwd).catch(() => undefined) : undefined;
        this.pendingStartedThreads.set(
          pendingThreadKey,
          {
            id: threadId,
            source: backend,
            title: agentName || "Untitled thread",
            titleSource: "fallback",
            projectKey: cwd,
            createdAt: startedAt,
            updatedAt: startedAt,
            executionMode: effectiveExecutionMode,
            ...modelSettings,
            acpRuntime,
            codexEnvironmentRuntime,
            linkedDirectories: dedupeLinkedDirectoriesByNormalizedIdentity(
              (
                resolvedLinkedDirectories?.length
                  ? resolvedLinkedDirectories
                  : buildLocalLinkedDirectory(cwd)
              ).map(normalizeLinkedDirectoryKind),
            ),
            gitBranch,
            ...(tokenMiserOverride !== undefined
              ? { tokenMiserEnabled: tokenMiserOverride }
              : {}),
          },
        );
      },
      markPlaceholder: (identity) => { this.threadNaming.markSystemPlaceholder(identity); },
      recordWorktreeOwner: async (identity) => {
        await this.recordCodexWorktreeOwnerThread({ ...identity, worktreePath: cwd });
      },
      invalidate: ({ threadId }) => { this.invalidateThreadListCache(backend, true, threadId, cwd ? [cwd] : []); },
      persistExecutionMode: async (identity) => await this.overlayStore.setThreadExecutionMode({ ...identity, executionMode: effectiveExecutionMode }),
      persistTokenMiser: async (identity) => await this.overlayStore.setThreadTokenMiser?.({ ...identity, enabled: tokenMiserOverride! }),
      persistPdfCatalog: async (identity) => await this.overlayStore.setThreadMessagingPdfToolCatalogVersion?.({
        ...identity, version: PWRAGENT_MESSAGING_PDF_TOOL_CATALOG_VERSION,
      }),
      persistGitBranch: async (identity) => await this.updateThreadGitBranchMetadata({ ...identity, branch: gitBranch }),
      persistPrAutoDispatch: async (identity) => await this.overlayStore.setThreadPrAutoDispatchEnabled({
        ...identity, enabled: prAutoDispatchEnabled ?? this.resolveDefaultPrAutoDispatchEnabledFn(),
      }),
      persistMcpSelection: async (identity) => await this.overlayStore.setThreadMcpConnectionIds({
        ...identity, connectionIds: mcpConnectionIds ?? [], providerServersEnabled: mcpProviderServersEnabled,
      }),
      persistAgent: async (identity) => {
        await this.overlayStore.setThreadAgent({ ...identity, agent: request.agent! });
        this.invalidateThreadListCache(backend);
      },
      persistEnvironment: async (identity) => await this.overlayStore.setThreadCodexEnvironmentRuntime?.({ ...identity, codexEnvironmentRuntime: codexEnvironmentRuntime! }),
      readModelMigration: () => {
        currentMigration = this.resolveProviderThreadModelMigrationsFn()[providerPickerValue(backend, modelSettings.model)];
        return currentMigration !== undefined;
      },
      persistModel: async (identity) => await this.overlayStore.setThreadModelSettings({
        ...identity,
        ...modelSettings,
        ...(currentMigration ? { modelMigrationRevision: currentMigration.revision } : {}),
      }),
      persistParent: async ({ threadId }) => {
        const saved = await this.overlayStore.setThreadParent?.({ backend, threadId, parentThreadId: parentThreadId!, parentThreadBackend, parentThreadInstanceId });
        return saved?.parentThreadId
          ? { parentThreadId: saved.parentThreadId, parentThreadBackend: saved.parentThreadBackend }
          : undefined;
      },
      announceParent: async ({ threadId }) => {
        await this.emit({ backend, notification: { method: "thread/parent/set", params: {
          threadId, parentThreadId: parentThreadId!, parentThreadBackend, parentThreadInstanceId,
        } } });
      },
      finalizeVisibility: async ({ threadId }, parent) => await this.finalizeCreatedThreadVisibility({
        backend, directoryKey, cwd,
        linkedDirectories: resolvedLinkedDirectories?.length ? resolvedLinkedDirectories : buildLocalLinkedDirectory(cwd),
        ...parent, threadId,
      }),
      announceStarted: async ({ threadId }) => {
        await this.emit({ backend, notification: { method: "thread/started", params: { threadId } } });
      },
      failed: (stage, error, identity) => {
        backendRegistryLog.warn("thread creation lifecycle effect failed", {
          backend, threadId: identity?.threadId, stage,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    }, metadata: { executionMode: effectiveExecutionMode, codexEnvironmentRuntime, codexEnvironmentStartupFailure } };
  }

  /**
   * Refuses a new, queued, steered or review turn on a locked thread. Every
   * turn source reaches one of the callers, so a lock needs no per-feature
   * check. The overlay row is read on each call: the lock can be written by
   * any window, an agent tool, or a peer, and a stale cache would let a turn
   * through.
   */
  private async assertThreadNotLocked(backend: AppServerBackendKind, threadId: string): Promise<void> {
    const lock = await this.readThreadLock(backend, threadId);
    if (lock) {
      throw new Error(threadLockRefusalMessage(lock));
    }
  }

  /** Whether the operator locked the thread; a lock outranks a project pause. */
  async isThreadLocked(params: { backend: AppServerBackendKind; threadId: string }): Promise<boolean> {
    return Boolean(await this.readThreadLock(params.backend, params.threadId));
  }

  /**
   * What keeps the thread's wakes from starting a turn now, for its Waiting
   * for list. A lock outranks a paused project, as it does at admission.
   */
  async readThreadWakeHold(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadPendingWakeHold | undefined> {
    const lock = await this.readThreadLock(params.backend, params.threadId);
    if (lock) return { kind: "thread_locked", ...(lock.note ? { note: lock.note } : {}) };
    const project = this.resolvePausedThreadProject(params);
    if (!project) return undefined;
    return {
      kind: "project_paused",
      projectLabel: project.label,
      directoryKey: project.directoryKey,
      ...(project.automation.wakeupPolicy === "discard" ? { discardsWakeups: true as const } : {}),
    };
  }

  /**
   * The thread's queue entries that wait for a release rather than for the
   * thread to be free: a project hold, a lock, or a failed turn. From memory.
   */
  listHeldThreadQueueEntries(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Array<{
    entryId: string;
    origin: ThreadTurnQueueOrigin;
    createdAt: number;
    holdReason?: string;
    projectHold?: { directoryKey: string; projectLabel: string; source: ProjectHeldWakeupSource; summary: string };
    text: string;
  }> {
    const held: ReturnType<DesktopBackendRegistry["listHeldThreadQueueEntries"]> = [];
    for (const entry of this.threadTurnQueue.iterateQueuedEntries(params)) {
      if (!entry.projectHold && !entry.manualReleaseRequired) continue;
      const text = entry.title
        || entry.input.find((item): item is Extract<AppServerTurnInputItem, { type: "text" }> => item.type === "text")?.text
        || "";
      held.push({
        entryId: entry.id,
        origin: entry.origin,
        createdAt: entry.createdAt,
        ...(entry.holdReason ? { holdReason: entry.holdReason } : {}),
        ...(entry.projectHold
          ? {
              projectHold: {
                ...entry.projectHold,
                projectLabel: getProjectForgeAutomationIndex().label(entry.projectHold.directoryKey),
              },
            }
          : {}),
        text,
      });
    }
    return held;
  }

  private async readThreadLock(backend: AppServerBackendKind, threadId: string): Promise<ThreadLock | undefined> {
    return (await this.overlayStore.getThreadOverlayState({ backend, threadId }))?.lock;
  }

  private assertThreadNotHandingOff(backend: AppServerBackendKind, threadId: string): void {
    this.threadArchiveCoordinator.cancelAutomaticArchive(backend, threadId);
    if (this.threadWorkspaceService.threadHandoffReservationRecords.has(buildThreadIdentityKey(backend, threadId))) {
      throw new Error("This thread is being handed off. Wait for the transfer to finish.");
    }
  }

  withThreadHandoff<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    return this.threadWorkspaceService.withThreadHandoff(threadId, work);
  }

  allocateHandoffWorktreePath(repositoryPath: string): Promise<string> {
    return this.threadWorkspaceService.allocateHandoffWorktreePath(repositoryPath);
  }

  exportThreadForHandoff(threadId: string): Promise<import("@pwragent/shared/contracts/thread-instance-handoff").ThreadHandoffExport> {
    return this.threadWorkspaceService.exportThreadForHandoff(threadId);
  }

  async forkThread(
    request: BackendRegistryForkThreadRequest,
  ): Promise<ForkThreadResponse> {
    this.assertNotBootstrap("forkThread");
    this.assertThreadOwnership();
    const backend = request.backend ?? "codex";
    if (backend !== "codex" && backend !== "claude") {
      throw new Error("Thread forking is supported by the Codex and Claude backends.");
    }

    const executionMode = request.executionMode ?? "default";
    const modeSettings = executionModeSettings(executionMode);
    const modelSettings = await this.admitNewThreadModelSettings(backend, request);
    const directoryKind =
      request.directoryKind ?? (request.directoryPath?.trim() ? "directory" : "workspace");
    const directoryLabel =
      request.directoryLabel?.trim() ||
      (request.directoryPath ? path.basename(request.directoryPath) : undefined) ||
      "Forked thread";
    const sourceOverlay = await this.overlayStore.getThreadOverlayState({
      backend,
      threadId: request.sourceThreadId,
    });
    // Imported worktrees already contain verified index and working-file state.
    // Their caller owns cleanup after retiring any partially created thread.
    const preparedWorkspace = request.importedWorktree
      ? {
          cwd: request.directoryPath,
          repositoryPath: request.importedWorktree.repositoryPath,
          workMode: "worktree" as const,
          rollback: undefined,
        }
      : await this.gitDirectoryService.prepareLaunchpadWorkspace({
          backend,
          branchName: request.branchName,
          directoryKind,
          directoryLabel,
          directoryPath: request.directoryPath,
          ...(request.excludedWorktreePaths
            ? { excludedWorktreePaths: request.excludedWorktreePaths }
            : {}),
          worktreeBranchMode: request.worktreeBranchMode,
          ...(request.rejectOccupiedBranch ? { rejectOccupiedBranch: true } : {}),
          workMode: request.workMode ?? "local",
        });
    if (request.workMode === "worktree" && preparedWorkspace.workMode !== "worktree") {
      throw new Error(
        `Requested worktree workspace, but workspace preparation resolved to ${preparedWorkspace.workMode}. Verify the source directory is a Git repository and branchName resolves to an existing branch or ref.`,
      );
    }
    request.onPreparedWorkspaceRollback?.(preparedWorkspace.rollback);
    const cwd = directoryKind === "workspace" && !preparedWorkspace.cwd
      ? await this.createScratchProjectDirectory()
      : preparedWorkspace.cwd;
    const linkedDirectories =
      preparedWorkspace.workMode === "worktree"
        ? buildWorktreeLinkedDirectory({
            label: directoryLabel,
            repositoryPath: preparedWorkspace.repositoryPath ?? request.directoryPath,
            worktreePath: request.importedWorktree?.worktreePath ?? cwd,
          })
        : buildLocalLinkedDirectory(cwd);
    let result: { threadId: string };
    let pdfMcpRegistration: AgentToolMcpRegistration | undefined;
    let forkedCodexEnvironmentRuntime: CodexThreadEnvironmentRuntime | undefined;
    let codexEnvironmentStartupFailure: CodexEnvironmentStartupFailure | undefined;
    if (backend === "claude") {
      // Claude copies the history and forks its session at the first message.
      try {
        result = await this.withArchiveWorkspaceWrite([cwd ?? "", ...linkedDirectories.map((directory) => linkedDirectoryWorktreePath(directory) ?? directory.path)], async () => await this.claudeBackend.forkThread({
          sourceThreadId: request.sourceThreadId,
          cwd: cwd!,
          model: modelSettings.model,
          executionMode,
          linkedDirectories: dedupeLinkedDirectoriesByNormalizedIdentity(
            linkedDirectories.map(normalizeLinkedDirectoryKind),
          ),
        }));
      } catch (error) {
        await preparedWorkspace.rollback?.();
        request.onPreparedWorkspaceRollback?.(undefined);
        throw error;
      }
    } else {
      const client = this.getClient(backend, executionMode);
      if (!client.forkThread) {
        await preparedWorkspace.rollback?.();
        request.onPreparedWorkspaceRollback?.(undefined);
        throw new Error("Selected backend does not support thread/fork.");
      }
      const sourceHasPdfMcpToolCatalog = this.hasPdfMcpToolCatalog(sourceOverlay);
      pdfMcpRegistration =
        sourceHasPdfMcpToolCatalog && this.resolvePdfAnalysisEnabledFn()
          ? await this.registerPdfMcpClient({})
          : undefined;
      const pdfMcpConfig = sourceHasPdfMcpToolCatalog
        ? pdfMcpRegistration
          ? buildCodexPdfMcpConfig(pdfMcpRegistration)
          : buildCodexPdfMcpDisabledConfig()
        : undefined;
      const tokenMiserEnabled = this.resolveTokenMiserEnabledForOverride(
        sourceOverlay?.tokenMiserEnabled,
      );
      if (tokenMiserEnabled) {
        await this.prepareTokenMiserRuntime();
      }
      const tokenMiserConfig = await this.buildSupportedCodexTokenMiserConfig({
        client,
        enabled: tokenMiserEnabled,
      });
      const codexThreadConfig = mergeCodexThreadConfigs(
        pdfMcpConfig,
        tokenMiserConfig,
      );

      try {
        try {
          const sourceRuntime = directoryKind === "workspace"
            ? undefined
            : Object.hasOwn(request, "codexEnvironmentRuntime")
              ? request.codexEnvironmentRuntime
              : sourceOverlay?.codexEnvironmentRuntime;
          forkedCodexEnvironmentRuntime = await this.threadDirectoryService.buildForkedCodexEnvironmentRuntime({
            cwd,
            forceSetup: request.rerunCodexEnvironmentSetup,
            onSetupProgress: request.onCodexEnvironmentSetupProgress
              ? (event) => {
                  request.onCodexEnvironmentSetupProgress?.({
                    directoryKey:
                      request.codexEnvironmentSetupProgressKey ??
                      `fork:${backend}:${request.sourceThreadId}`,
                    ...event,
                  });
                }
              : undefined,
            sourceRuntime,
            workMode: preparedWorkspace.workMode,
          });
        } catch (error) {
          if (!(error instanceof CodexEnvironmentStartupError)) {
            throw error;
          }
          forkedCodexEnvironmentRuntime = error.runtime;
          codexEnvironmentStartupFailure = {
            message: error.message,
            phase: error.phase,
            worktreeCleanupAvailable: preparedWorkspace.workMode === "worktree",
          };
        }
        result = await this.withArchiveWorkspaceWrite([cwd ?? "", ...linkedDirectories.map((directory) => linkedDirectoryWorktreePath(directory) ?? directory.path)], async () => await client.forkThread!({
          threadId: request.sourceThreadId,
          ...(request.sourceThreadPath?.trim()
            ? { path: request.sourceThreadPath.trim() }
            : {}),
          cwd,
          ...modelSettings,
          approvalPolicy: request.approvalPolicy ?? modeSettings.approvalPolicy,
          approvalsReviewer: modeSettings.approvalsReviewer,
          sandbox: ownerSandboxForMode(getOwnerHostServices().runtimePolicy, executionMode, request.sandbox, modeSettings.sandbox),
          codexEnvironmentRuntime: forkedCodexEnvironmentRuntime,
          ...(codexThreadConfig ? { config: codexThreadConfig } : {}),
        }));
        pdfMcpRegistration?.bindThread(result.threadId);
      } catch (error) {
        await preparedWorkspace.rollback?.();
        request.onPreparedWorkspaceRollback?.(undefined);
        throw error;
      }
    }
    let gitBranch: string | undefined;
    try {
      const forkedAt = Date.now();
      gitBranch = cwd ? await readCurrentGitBranch(cwd).catch(() => undefined) : undefined;
      this.pendingStartedThreads.set(buildThreadIdentityKey(backend, result.threadId), {
        id: result.threadId,
        source: backend,
        title: "Forked thread",
        titleSource: "fallback",
        projectKey: cwd,
        createdAt: forkedAt,
        updatedAt: forkedAt,
        executionMode,
        ...modelSettings,
        ...(forkedCodexEnvironmentRuntime
          ? { codexEnvironmentRuntime: forkedCodexEnvironmentRuntime }
          : {}),
        linkedDirectories: dedupeLinkedDirectoriesByNormalizedIdentity(
          linkedDirectories.map(normalizeLinkedDirectoryKind),
        ),
        gitBranch,
      });

      if (preparedWorkspace.workMode === "worktree") {
        await this.recordCodexWorktreeOwnerThread({
          backend,
          threadId: result.threadId,
          worktreePath: request.importedWorktree?.worktreePath ?? cwd,
        });
      }

      const linkedDirectory = linkedDirectories[0];
      if (linkedDirectory) {
        // The fork response can become visible through thread/list before Codex
        // has replaced the copied parent cwd. Persist the prepared workspace now
        // so that transient provider metadata cannot become the child's source
        // of truth.
        await this.threadDirectoryService.replaceWorkspaceLinkedDirectory({
          backend,
          threadId: result.threadId,
          directory: linkedDirectory,
          gitBranch,
        });
      }

      await this.overlayStore.setThreadExecutionMode({
        backend,
        threadId: result.threadId,
        executionMode,
      });
      if (backend === "codex" && sourceOverlay?.tokenMiserEnabled !== undefined) {
        await this.overlayStore.setThreadTokenMiser({
          backend,
          threadId: result.threadId,
          enabled: sourceOverlay.tokenMiserEnabled,
        });
      }
      await this.overlayStore.setThreadPrAutoDispatchEnabled({
        backend,
        threadId: result.threadId,
        enabled: this.resolveDefaultPrAutoDispatchEnabledFn(),
      });
      if (
        pdfMcpRegistration
        && typeof this.overlayStore.setThreadMessagingPdfToolCatalogVersion === "function"
      ) {
        await this.overlayStore.setThreadMessagingPdfToolCatalogVersion({
          backend,
          threadId: result.threadId,
          version: PWRAGENT_MESSAGING_PDF_TOOL_CATALOG_VERSION,
        });
      }
      const currentMigration =
        this.resolveProviderThreadModelMigrationsFn()[providerPickerValue(backend, modelSettings.model)];
      if (
        modelSettings.model !== undefined ||
        modelSettings.reasoningEffort !== undefined ||
        modelSettings.serviceTier !== undefined ||
        modelSettings.fastMode !== undefined ||
        currentMigration !== undefined
      ) {
        await this.overlayStore.setThreadModelSettings({
          backend,
          threadId: result.threadId,
          ...modelSettings,
          ...(currentMigration
            ? {
                modelMigrationRevision: currentMigration.revision,
              }
            : {}),
        });
      }
      if (forkedCodexEnvironmentRuntime) {
        await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
          backend,
          threadId: result.threadId,
          codexEnvironmentRuntime: forkedCodexEnvironmentRuntime,
        });
      }
      if (request.parentThreadId?.trim()) {
        await this.overlayStore.setThreadParent?.({
          backend,
          threadId: result.threadId,
          parentThreadId: request.parentThreadId,
          parentThreadBackend: request.parentThreadBackend,
          parentThreadInstanceId: request.parentThreadInstanceId,
        });
        await this.emit({
          backend,
          notification: {
            method: "thread/parent/set",
            params: {
              threadId: result.threadId,
              parentThreadId: request.parentThreadId,
              parentThreadBackend: request.parentThreadBackend,
              parentThreadInstanceId: request.parentThreadInstanceId,
            },
          },
        });
      }
      // Record the fork origin so live-usage pricing knows this thread inherited
      // a copied-in history from `sourceThreadId` and must not re-bill it. This
      // is distinct from `parentThreadId` (an overloaded UI grouping marker).
      if (request.sourceThreadId?.trim()) {
        await this.overlayStore.setThreadForkOrigin?.({
          backend,
          threadId: result.threadId,
          forkSourceThreadId: request.sourceThreadId,
        });
      }
      await this.updateThreadGitBranchMetadata({
        backend,
        threadId: result.threadId,
        branch: gitBranch,
      });
      this.invalidateThreadListCache(backend, true, result.threadId, cwd ? [cwd] : []);
    } catch (error) {
      this.pendingStartedThreads.delete(buildThreadIdentityKey(backend, result.threadId));
      await preparedWorkspace.rollback?.();
      request.onPreparedWorkspaceRollback?.(undefined);
      throw error;
    }
    const visibilityFinalization = await this.finalizeCreatedThreadVisibility({
      backend,
      cwd,
      linkedDirectories,
      parentThreadBackend: request.parentThreadBackend,
      parentThreadId: request.parentThreadId,
      threadId: result.threadId,
    });
    // Provider thread/started can arrive before the fork's workspace overlay
    // is saved. Publish membership again once the prepared link is durable.
    await this.threadDirectoryService.emitCodexDirectoryRelationshipsUpdated({
      reason: "thread-created",
      threadIds: [result.threadId],
    });

    return {
      backend,
      sourceThreadId: request.sourceThreadId,
      threadId: result.threadId,
      executionMode,
      ...visibilityFinalization,
      linkedDirectory: linkedDirectories[0],
      workMode: preparedWorkspace.workMode,
      ...(gitBranch ? { gitBranch, observedGitBranch: gitBranch } : {}),
      codexEnvironmentRuntime: forkedCodexEnvironmentRuntime,
      codexEnvironmentStartupFailure,
    };
  }

  /** Reserve submission order until the queue claims a position, not until
   * the provider responds. Other threads retain their independent admissions. */
  private async admitThreadAttachments<T>(
    params: ThreadAssetOwner & { input: AppServerTurnInputItem[] },
    admit: (input: AppServerTurnInputItem[], onAdmission: () => void) => Promise<T>,
  ): Promise<T> {
    const key = buildThreadIdentityKey(params.backend, params.threadId);
    const { submission } = await this.threadAttachmentAdmissionLocks.run(key, async () => {
      const input = await ownThreadInputAttachments(params.input, params, this.localFilePrivateStorageRoots);
      let onAdmission!: () => void;
      const admitted = new Promise<void>((resolve) => { onAdmission = resolve; });
      const submission = admit(input, onAdmission);
      // A rejected admission must also release the next sender's reservation.
      void submission.then(onAdmission, onAdmission);
      await admitted;
      return { submission };
    });
    return await submission;
  }

  async submitTurn(params: {
    queueEntryId?: string;
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin?: ThreadTurnQueueOrigin;
    executionMode?: ThreadExecutionMode;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    automationRunId?: string;
    messageOrigin?: AppServerThreadMessageOrigin;
    delivery?: "new_turn";
  }, turnInputSource?: TurnInputSource): Promise<ThreadTurnQueueSubmissionResult> {
    assertOwnerExecutionPolicy(getOwnerHostServices().runtimePolicy, params);
    await this.assertThreadCodexInferenceAvailable(params);
    await this.assertAgentMessageWithinThreadAccess(params);
    await this.threadModelSettings.assertRequestedThreadModelAvailable(params);
    await this.assertThreadNotLocked(params.backend, params.threadId);
    this.assertThreadNotHandingOff(params.backend, params.threadId);
    // A hibernated checkout starts coming back now; the send queues behind it.
    await this.threadArchiveCoordinator.wakeHibernatedCheckout(params);
    const { origin = "manual", queueEntryId, delivery, ...entry } = params;
    const hasTurnSettings = [
      entry.executionMode,
      entry.approvalPolicy,
      entry.sandbox,
      entry.model,
      entry.collaborationMode,
      entry.serviceTier,
      entry.reasoningEffort,
      entry.fastMode,
    ].some((value) => value !== undefined);
    return await this.admitThreadAttachments(entry, (input, onAdmission) => {
      const prepared = { ...entry, input, ...(queueEntryId ? { id: queueEntryId } : {}), origin, turnInputSource };
      // Agent messages, monitor results and PwrAgent's own wakes join the
      // running turn, or start one when the thread is idle, and share that
      // delivery with whatever waits beside them. An operator's or a
      // messaging app's send keeps its own turn.
      return isSteerableAgentTraffic(entry.messageOrigin) && delivery !== "new_turn" && !hasTurnSettings
        ? this.threadTurnQueue.submitSteer(prepared, { onAdmission })
        : this.threadTurnQueue.submit(prepared, { onAdmission });
    });
  }

  /**
   * An operator's reply to a thread no composer shows, such as an answer to
   * its question from the To-dos panel. It starts, steers or queues as a
   * composer reply does, decided by the FIFO when it reaches the head, and
   * carries no turn settings, so the thread's own apply.
   */
  async submitThreadReply(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
  }, turnInputSource?: TurnInputSource): Promise<ThreadTurnQueueSubmissionResult> {
    assertOwnerExecutionPolicy(getOwnerHostServices().runtimePolicy, params);
    await this.assertThreadCodexInferenceAvailable(params);
    await this.assertThreadNotLocked(params.backend, params.threadId);
    this.assertThreadNotHandingOff(params.backend, params.threadId);
    return await this.admitThreadAttachments(params, (input, onAdmission) =>
      this.threadTurnQueue.submitSteer({ ...params, input, origin: "manual", turnInputSource }, { onAdmission }));
  }

  async submitHeldTurn(params: {
    queueEntryId: string;
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    holdReason: string;
    origin?: ThreadTurnQueueOrigin;
    executionMode?: ThreadExecutionMode;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    messageOrigin?: AppServerThreadMessageOrigin;
    /** Names the entry in the queue and Waiting for, in place of its text. */
    title?: string;
  }, turnInputSource?: TurnInputSource): Promise<Extract<ThreadTurnQueueSubmissionResult, { status: "queued" }>> {
    assertOwnerExecutionPolicy(getOwnerHostServices().runtimePolicy, params);
    await this.assertThreadCodexInferenceAvailable(params);
    await this.assertAgentMessageWithinThreadAccess(params);
    // No lock check: a held entry starts nothing until it is released, and
    // the release is refused while the thread is locked. Holding is how a
    // lock pauses a delivery, such as a monitor's result, without losing it.
    this.assertThreadNotHandingOff(params.backend, params.threadId);
    const {
      holdReason,
      origin = "manual",
      queueEntryId,
      ...entry
    } = params;
    return await this.admitThreadAttachments(entry, (input, onAdmission) => this.threadTurnQueue.submitHeld({
      ...entry,
      input,
      id: queueEntryId,
      origin,
      turnInputSource,
    }, holdReason, { onAdmission }));
  }

  /**
   * Holds a turn a backend started inside its own process while the thread
   * is locked: Claude's answer to a finished background task, a /loop
   * wake-up, or a session cron's fire. Each distinct prompt has its own
   * immutable held identity, in FIFO order. A recurring wake that fires again
   * while its prompt still waits is kept once. False when no lock holds the
   * thread: the backend runs it.
   */
  async holdBackendSelfStartedTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prompt: string;
    source: ClaudeSelfStartedTurnSource;
  }): Promise<boolean> {
    const identity = { backend: params.backend, threadId: params.threadId };
    return await this.admitThreadAttachments({ ...identity, input: [{ type: "text", text: params.prompt }] }, async (input, onAdmission) => {
      // Deduplicate inside the existing admission reservation. Concurrent hooks
      // see the first accepted row even while its lifecycle publication awaits.
      const lock = await this.readThreadLock(params.backend, params.threadId);
      if (!lock) { onAdmission(); return false; }
      this.assertThreadNotHandingOff(params.backend, params.threadId);
      for (const entry of this.threadTurnQueue.iterateQueuedEntries(identity)) {
        if (entry.id.startsWith(SELF_STARTED_TURN_ENTRY_PREFIX)
          && entry.messageOrigin?.kind === "pwragent"
          && entry.input.some(item => item.type === "text" && item.text === params.prompt)) {
          onAdmission();
          return true;
        }
      }
      await this.threadTurnQueue.submitHeld({
        ...identity,
        id: `${SELF_STARTED_TURN_ENTRY_PREFIX}${randomUUID()}`,
        input,
        origin: "manual",
        messageOrigin: { kind: "pwragent" },
        title: selfStartedTurnTitle(params.source),
      }, threadLockRefusalMessage(lock), { onAdmission });
      return true;
    });
  }

  /**
   * The thread's Directories project and its Forge Automation, when that
   * project stores a setting. Owner-local and synchronous: it reads only the
   * in-memory index and this registry's cached summary.
   */
  resolveThreadForgeProject(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): ProjectForgeAutomationResolution | undefined {
    return getProjectForgeAutomationIndex().resolveThread(
      params,
      () => this.getCachedThreadSummary(params),
    );
  }

  /** The thread's project when it is paused; undefined otherwise. */
  resolvePausedThreadProject(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): ProjectForgeAutomationResolution | undefined {
    const project = this.resolveThreadForgeProject(params);
    return project?.automation.paused ? project : undefined;
  }

  /**
   * Refusal text when the target's paused project refuses messages from
   * other threads, or undefined when the message may go through.
   */
  projectPausedThreadMessageRefusal(target: {
    backend: AppServerBackendKind;
    threadId: string;
  }): string | undefined {
    const project = this.resolveThreadForgeProject(target);
    if (!project || !projectRefusesThreadMessages(project.automation)) return undefined;
    const title = this.getCachedThreadSummary(target)?.title.trim();
    return buildProjectPausedThreadMessageRefusal({
      projectLabel: project.label,
      ...(title ? { threadTitle: title } : {}),
    });
  }

  /**
   * Throws when an agent's message from another thread reaches a local
   * thread whose paused project refuses them. Operator, messaging-app and
   * PwrAgent deliveries always pass.
   */
  assertProjectAcceptsThreadMessage(params: {
    backend: AppServerBackendKind;
    threadId: string;
    messageOrigin?: AppServerThreadMessageOrigin;
  }): void {
    if (params.messageOrigin?.kind !== "agent" || params.messageOrigin.operatorApproved) return;
    const refusal = this.projectPausedThreadMessageRefusal(params);
    if (refusal) throw new ProjectPausedThreadMessageError(refusal);
  }

  /**
   * Deliver a wake-up, such as a finished monitor or a Continue After
   * dependency, to a thread whose project is paused. `hold` queues it as a
   * paused, project-held entry the operator's own sends pass; `discard`
   * drops it and leaves a note in the thread.
   */
  async deliverProjectPausedWakeup(params: {
    project: ProjectForgeAutomationResolution;
    queueEntryId: string;
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin: ThreadTurnQueueOrigin;
    messageOrigin?: AppServerThreadMessageOrigin;
    source: ProjectHeldWakeupSource;
    summary: string;
  }): Promise<
    | Extract<ThreadTurnQueueSubmissionResult, { status: "queued" }>
    | { status: "discarded" }
  > {
    const projectLabel = params.project.label;
    if (params.project.automation.wakeupPolicy === "discard") {
      backendRegistryLog.info("project paused: wake-up discarded", {
        backend: params.backend,
        threadId: params.threadId,
        directoryKey: params.project.directoryKey,
        source: params.source,
      });
      // The note is history only. Codex accepts injected items only between
      // turns; a busy Codex thread keeps the log line above instead.
      if (params.backend !== "codex" || this.canStartThreadTurnImmediately(params)) {
        await this.subAgentMonitorService.injectTaskMonitorCompletionMessage({
          backend: params.backend,
          monitorId: `project-pause:${randomUUID()}`,
          parentThreadId: params.threadId,
          text: buildProjectPausedWakeupDiscardNote({ projectLabel, summary: params.summary }),
        }).catch((error: unknown) => {
          backendRegistryLog.warn("project paused: discard note failed", {
            backend: params.backend,
            threadId: params.threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return { status: "discarded" };
    }
    this.assertThreadNotHandingOff(params.backend, params.threadId);
    const entry = {
      backend: params.backend,
      threadId: params.threadId,
      input: params.input,
      origin: params.origin,
      ...(params.messageOrigin ? { messageOrigin: params.messageOrigin } : {}),
    };
    return await this.admitThreadAttachments(entry, (input, onAdmission) =>
      this.threadTurnQueue.submitProjectHeld({
        ...entry,
        input,
        id: params.queueEntryId,
      }, {
        reason: buildProjectPausedWakeupHoldReason({ projectLabel }),
        projectHold: {
          directoryKey: params.project.directoryKey,
          source: params.source,
          summary: params.summary,
        },
      }, { onAdmission }));
  }

  /**
   * Puts back the wake-ups that exited instances held. Their sources were
   * consumed when they were held, so the durable copy is all that is left.
   * Runs in the constructor, before any window reads the queue.
   */
  private restoreProjectHeldWakeups(): void {
    if (!this.projectHeldWakeupStore) return;
    let claimed: StoredProjectHeldWakeup[];
    try {
      claimed = this.projectHeldWakeupStore.claimOrphaned(
        this.runtimeInstanceId,
        this.resolveLiveProfileRuntimeInstanceIdsFn,
      );
    } catch (error) {
      backendRegistryLog.warn("project held wake-ups could not be restored", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (claimed.length === 0) return;
    for (const wakeup of claimed) this.durableProjectHeldWakeups.set(wakeup.id, wakeup);
    const restored = this.threadTurnQueue.restoreProjectHeld(claimed.map((wakeup) => ({
      ...wakeup,
      origin: THREAD_TURN_QUEUE_ORIGINS.includes(wakeup.origin)
        ? wakeup.origin as ThreadTurnQueueOrigin
        : "automation",
    })));
    backendRegistryLog.info("project held wake-ups restored", {
      count: restored.length,
      entryIds: restored.map((entry) => entry.id),
    });
  }

  /**
   * Keeps one durable copy per project-held entry: written when the hold
   * is queued, deleted when the entry leaves the queue. A Send keeps the
   * copy until its turn starts, so a restart before then holds it again
   * rather than losing it.
   */
  private trackDurableProjectHeldWakeup(event: ThreadTurnQueueLifecycleEvent): void {
    const store = this.projectHeldWakeupStore;
    if (!store) return;
    const { entry } = event;
    try {
      if (event.type === "queued") {
        if (!entry.projectHold || this.durableProjectHeldWakeups.has(entry.id)) return;
        const wakeup: StoredProjectHeldWakeup = {
          id: entry.id,
          backend: entry.backend,
          threadId: entry.threadId,
          origin: entry.origin,
          ...(entry.messageOrigin ? { messageOrigin: entry.messageOrigin } : {}),
          input: entry.input,
          createdAt: entry.createdAt,
          holdReason: entry.holdReason ?? "",
          projectHold: entry.projectHold,
        };
        store.save(this.runtimeInstanceId, wakeup);
        this.durableProjectHeldWakeups.set(entry.id, wakeup);
        return;
      }
      if (event.type === "started" || event.type === "failed" || event.type === "cancelled") {
        this.forgetDurableProjectHeldWakeup(entry.id);
      }
    } catch (error) {
      backendRegistryLog.warn("project held wake-up durability failed", {
        entryId: entry.id,
        event: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Deletes the row before untracking it, so a failed delete stays visible. */
  private forgetDurableProjectHeldWakeup(entryId: string): void {
    if (!this.projectHeldWakeupStore || !this.durableProjectHeldWakeups.has(entryId)) return;
    try {
      this.projectHeldWakeupStore.remove(entryId);
      this.durableProjectHeldWakeups.delete(entryId);
    } catch (error) {
      backendRegistryLog.warn("project held wake-up could not be forgotten", {
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** An operator edit to a held wake-up replaces its durable input too. */
  private refreshDurableProjectHeldWakeup(entry: ThreadTurnQueueEntry): void {
    const stored = this.durableProjectHeldWakeups.get(entry.id);
    if (!stored || !this.projectHeldWakeupStore) return;
    const wakeup: StoredProjectHeldWakeup = {
      ...stored,
      input: entry.input,
      ...(entry.messageOrigin ? { messageOrigin: entry.messageOrigin } : {}),
    };
    try {
      this.projectHeldWakeupStore.update(wakeup);
      this.durableProjectHeldWakeups.set(entry.id, wakeup);
    } catch (error) {
      backendRegistryLog.warn("project held wake-up edit was not saved", {
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Whether the quiet-restart gate is shut: a quiet restart is under way, or
   * this launch is still sending the continuations the last one left. While
   * it is shut, no queued entry starts or steers except a continuation at
   * its own time, and the sources that bypass the queue stand down.
   */
  isRestartGateClosed(): boolean {
    return this.restartGate.phase !== "open";
  }

  /** Called with `true` when the gate shuts and `false` when it opens. */
  onRestartGateChanged(listener: (closed: boolean) => void): () => void {
    this.restartGateListeners.add(listener);
    return () => {
      this.restartGateListeners.delete(listener);
    };
  }

  /** For the main window's notice: what the gate holds and until when. */
  getRestartGateStatus(): RestartGateStatus {
    const gate = this.restartGate;
    if (gate.phase !== "resuming") return { phase: gate.phase };
    const times = [...gate.pending.values()]
      .map((item) => item.dispatchAt)
      .filter((at) => Number.isFinite(at));
    return {
      phase: "resuming",
      waiting: gate.pending.size,
      ...(times.length > 0 ? { nextAt: Math.min(...times) } : {}),
      ...(Number.isFinite(gate.releaseBy) ? { releaseBy: gate.releaseBy } : {}),
    };
  }

  onRestartGateStatusChanged(listener: (status: RestartGateStatus) => void): () => void {
    this.restartGateStatusListeners.add(listener);
    return () => {
      this.restartGateStatusListeners.delete(listener);
    };
  }

  /**
   * The operator's "Start everything now": opens the gate, so each waiting
   * continuation and everything behind it starts at once. A quiet restart
   * under way stays shut.
   */
  releaseRestartGate(): RestartGateStatus {
    this.applyRestartGate({ type: "release" });
    return this.getRestartGateStatus();
  }

  private publishRestartGateStatus(): void {
    const status = this.getRestartGateStatus();
    for (const listener of this.restartGateStatusListeners) {
      try {
        listener(status);
      } catch (error) {
        backendRegistryLog.warn("restart gate status listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private applyRestartGate(event: RestartGateEvent): void {
    const wasClosed = this.isRestartGateClosed();
    const previous = this.restartGate;
    this.restartGate = transitionRestartGate(this.restartGate, event);
    if (this.restartGate !== previous) this.publishRestartGateStatus();
    const closed = this.isRestartGateClosed();
    if (wasClosed === closed) return;
    if (!closed) {
      for (const timer of this.restartGateTimers) clearTimeout(timer);
      this.restartGateTimers.clear();
      backendRegistryLog.info("restart gate opened", { event: event.type });
      // Everything the gate held waits in its FIFO; start what can start.
      this.threadTurnQueue.drainAll();
    } else {
      backendRegistryLog.info("restart gate closed", { event: event.type });
    }
    for (const listener of this.restartGateListeners) {
      try {
        listener(closed);
      } catch (error) {
        backendRegistryLog.warn("restart gate listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * The running turns a quiet restart stops: one per thread, never a
   * sub-agent's (its parent's continuation resumes it) or a headless
   * automation run's (the automation owns that run).
   */
  private listQuietRestartTargets(): QuietRestartTarget[] {
    const automationThreadKeys = new Set([...this.headlessAutomation.runningTurns()]
      .map((run) => buildThreadIdentityKey(run.backend, run.executionThreadId)));
    const targets = new Map<string, QuietRestartTarget>();
    for (const key of this.context.turnState.registeredTurnKeys()) {
      const parsed = parseActiveTurnKey(key);
      if (!parsed) continue;
      const threadKey = buildThreadIdentityKey(parsed.backend, parsed.threadId);
      if (automationThreadKeys.has(threadKey) || targets.has(threadKey)) continue;
      if (this.subAgentMonitorService.resolveSubAgentThreadOwner(parsed).isSubAgent) continue;
      targets.set(threadKey, parsed);
    }
    return [...targets.values()];
  }

  /**
   * Starts a quiet restart: shuts the restart gate so nothing new starts,
   * and returns the running turns it will stop. Nothing is stopped yet.
   */
  beginQuietRestart(): QuietRestartTarget[] {
    if (this.restartGate.phase !== "quieting") {
      this.beforeQuietRestartGate = this.restartGate;
      this.quietRestartCheckpoint.clear();
    }
    this.applyRestartGate({ type: "quiet", at: Date.now() });
    return this.listQuietRestartTargets();
  }

  /** Restore admission, and recover checkpointed work if preparation had already quieted it. */
  cancelQuietRestart(resumeCheckpoint = false): void {
    if (resumeCheckpoint) {
      const saved = [...this.quietRestartCheckpoint.values()].map((entry) => entry.kind === undefined
        ? { ...entry, input: [{ type: "text" as const, text: "The PwrAgent restart was cancelled after quieting. Resume the preserved task, checking its current progress before repeating any action." }] }
        : this.cancelUpgradeVerification(entry));
      const receipts = saved.filter((entry) => entry.kind === "queued");
      try { if (receipts.length) this.restartContinuationStore?.saveAll(this.runtimeInstanceId, receipts); }
      catch (error) { backendRegistryLog.warn("cancelled restart receipt could not be updated", { error: String(error) }); }
      for (const entry of saved) this.durableRestartContinuations.set(entry.id, entry);
      this.threadTurnQueue.restoreQueued(receipts.map((entry) => restartQueuedEntry(entry)));
      this.threadTurnQueue.restoreRestartContinuations(saved.filter((entry) => entry.kind === undefined).map((entry) => ({
        id: entry.id, backend: entry.backend, threadId: entry.threadId, origin: "scheduled" as const,
        input: entry.input, messageOrigin: entry.messageOrigin, createdAt: entry.createdAt,
      })));
    }
    this.quietRestartCheckpoint.clear();
    const previous = this.beforeQuietRestartGate ?? OPEN_RESTART_GATE;
    this.beforeQuietRestartGate = undefined;
    this.applyRestartGate({ type: "cancel-quiet", previous: transitionRestartGate(previous, { type: "deadline", at: Date.now() }) });
  }

  /**
   * Tells each running turn that the app is restarting, as a steer, where
   * the backend can take one into the running turn. ACP steering can queue
   * a new turn instead, so those turns hear about it in their continuation
   * only. Bounded per steer; a refusal or timeout moves on. Returns how
   * many turns were steered.
   */
  async steerTurnsForQuietRestart(targets: readonly QuietRestartTarget[]): Promise<number> {
    const results = await Promise.all(targets.map(async (target) => {
      if (target.backend !== "codex" && target.backend !== "claude") return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.steerTurn({
            backend: target.backend,
            threadId: target.threadId,
            expectedTurnId: target.turnId,
            requestId: `quiet-restart:${target.backend}:${target.threadId}:${target.turnId}`,
            input: [{ type: "text", text: QUIET_RESTART_STEER_TEXT }],
          }, QUIET_RESTART_STEER_ORIGIN).then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), QUIET_RESTART_STEER_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        backendRegistryLog.info("quiet restart steer refused", {
          backend: target.backend,
          threadId: target.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      } finally {
        clearTimeout(timer);
      }
    }));
    return results.filter(Boolean).length;
  }

  /** Resolves once none of these turns is running, or at the deadline. */
  async waitForQuietRestartTurns(
    targets: readonly QuietRestartTarget[],
    timeoutMs: number,
  ): Promise<"ended" | "deadline"> {
    const running = () => targets.some((target) =>
      this.getActiveTurnForThread(target)?.turnId === target.turnId);
    if (!running()) return "ended";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      return await Promise.race([
        new Promise<"ended">((resolve) => {
          unsubscribe = this.context.turnState.onTurnUnregistered(() => {
            if (!running()) resolve("ended");
          });
        }),
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
    }
  }

  /**
   * Writes one durable continuation for each target thread, and for any
   * other thread whose turn is still running, in one commit. The quit that
   * follows interrupts the turns; the next launch continues them. Returns
   * how many threads will be continued.
   */
  saveRestartContinuations(targets: readonly QuietRestartTarget[], stoppedAt = Date.now(), requireCheckpoint = false): number {
    const store = this.restartContinuationStore;
    if (!store) {
      if (requireCheckpoint) throw new Error("Restart continuation storage is unavailable; quiet restart cancelled.");
      return 0;
    }
    const threads = new Map<string, QuietRestartTarget>();
    for (const target of [...targets, ...this.listQuietRestartTargets()]) {
      threads.set(buildThreadIdentityKey(target.backend, target.threadId), target);
    }
    const text = buildRestartContinuationText(stoppedAt);
    const continuations: StoredRestartContinuation[] = [...threads.values()].map((target, index) => ({
      id: `restart-continuation:${randomUUID()}`,
      backend: target.backend,
      threadId: target.threadId,
      messageOrigin: { kind: "pwragent", systemReason: "app-restart" },
      input: [{ type: "text", text }],
      // Keeps the stop order stable when the next launch sorts by time.
      createdAt: stoppedAt + index,
    }));
    // Messages waiting in queues live only in memory; carry them across too.
    const queued = [...this.restartQueuedSnapshot(), ...(this.appRestartVerification ? [this.appRestartVerification] : [])];
    try {
      const saved = store.saveAll(this.runtimeInstanceId, [...continuations, ...queued]);
      for (const entry of saved) this.quietRestartCheckpoint.set(entry.id, entry);
      if (this.appRestartVerification) this.quietRestartCheckpoint.set(this.appRestartVerification.id, this.appRestartVerification);
      for (const entry of queued) this.durableRestartContinuations.set(entry.id, entry);
      backendRegistryLog.info("restart continuations saved", {
        count: saved.length,
        queued: queued.length,
        threads: [...threads.keys()],
      });
      return saved.length;
    } catch (error) {
      backendRegistryLog.warn("restart continuations could not be saved", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (requireCheckpoint) throw error;
      return 0;
    }
  }

  /**
   * Puts back the continuations an exited instance saved, at the top of
   * each thread's queue, and shuts the restart gate until they start. Runs
   * in the constructor, before any window or source reads the queue.
   * Dispatch times are set by `beginRestartContinuationDispatch`.
   */
  private restoreRestartContinuations(): void {
    const store = this.restartContinuationStore;
    if (!store) return;
    let claimed: StoredRestartContinuation[];
    try {
      claimed = store.claimOrphaned(this.runtimeInstanceId, this.resolveLiveProfileRuntimeInstanceIdsFn);
    } catch (error) {
      backendRegistryLog.warn("restart continuations could not be restored", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (claimed.length === 0) return;
    for (const continuation of claimed) this.durableRestartContinuations.set(continuation.id, continuation);
    // In the order they waited. Rows from before positions were saved, or
    // from another restart, follow by time.
    const position = (stored: StoredRestartContinuation) => stored.queued?.position ?? Number.MAX_SAFE_INTEGER;
    const queued = this.threadTurnQueue.restoreQueued(claimed
      .filter((continuation) => continuation.kind === "queued")
      .sort((left, right) => position(left) - position(right) || left.createdAt - right.createdAt)
      .map((continuation) => restartQueuedEntry(continuation)));
    if (queued.length > 0) {
      backendRegistryLog.info("restart queued messages restored", {
        count: queued.length,
        entryIds: queued.map((entry) => entry.id),
      });
    }
    const restored = this.threadTurnQueue.restoreRestartContinuations(claimed
      .filter((continuation) => continuation.kind === undefined)
      .map((continuation) => ({
      id: continuation.id,
      backend: continuation.backend,
      threadId: continuation.threadId,
      origin: "scheduled" as const,
      input: continuation.input,
      ...(continuation.messageOrigin ? { messageOrigin: continuation.messageOrigin } : {}),
      createdAt: continuation.createdAt,
      })));
    if (restored.length === 0) return;
    this.applyRestartGate({
      type: "restore",
      schedule: restored.map((entry) => ({
        entryId: entry.id,
        threadKey: buildThreadIdentityKey(entry.backend, entry.threadId),
        dispatchAt: Number.POSITIVE_INFINITY,
      })),
      releaseBy: Number.POSITIVE_INFINITY,
    });
    backendRegistryLog.info("restart continuations restored", {
      count: restored.length,
      entryIds: restored.map((entry) => entry.id),
    });
    const fallback = setTimeout(() => this.beginRestartContinuationDispatch(), RESTART_DISPATCH_FALLBACK_MS);
    fallback.unref?.();
    this.restartGateTimers.add(fallback);
  }

  /**
   * Gives each restored continuation its dispatch time, in staggered
   * batches, once providers can take a turn. Runs once; the first call wins.
   */
  beginRestartContinuationDispatch(): void {
    if (this.restartDispatchStarted) return;
    if (this.restartGate.phase !== "resuming") {
      // A caller can finish during quieting, leaving only queued input or
      // its verification receipt. There is no running-turn continuation to
      // open the gate and trigger a drain. Wait for this provider-ready call.
      if (this.restartGate.phase === "open" && this.durableRestartContinuations.size > 0) {
        this.restartDispatchStarted = true;
        this.threadTurnQueue.drainAll();
      }
      return;
    }
    this.restartDispatchStarted = true;
    // Every restored continuation still in a queue gets a time, settled ones
    // too: one a lock held before dispatch began still waits its turn once
    // unlocked. One that was discarded takes no place in the stagger.
    const { pending } = this.restartGate;
    const queued = new Set(this.threadTurnQueue.getAllQueuedEntries().map((entry) => entry.id));
    const now = Date.now();
    const plan = planRestartDispatch([...this.restartGate.scheduled.values()]
      .filter((item) => pending.has(item.entryId) || queued.has(item.entryId)), {
      ...this.restartDispatchPlanOptions,
      now,
    });
    this.restartGate = {
      phase: "resuming",
      pending: new Map(plan.schedule
        .filter((item) => pending.has(item.entryId))
        .map((item) => [item.entryId, item])),
      scheduled: new Map(plan.schedule.map((item) => [item.entryId, item])),
      releaseBy: plan.releaseBy,
    };
    this.publishRestartGateStatus();
    backendRegistryLog.info("restart continuation dispatch scheduled", {
      count: plan.schedule.length,
      firstAt: Math.min(...plan.schedule.map((item) => item.dispatchAt)),
      releaseBy: plan.releaseBy,
    });
    for (const item of plan.schedule) {
      const parsed = parseThreadIdentityKey(item.threadKey);
      if (!parsed) continue;
      const timer = setTimeout(() => {
        this.restartGateTimers.delete(timer);
        this.threadTurnQueue.scheduleThreadDrain(parsed);
      }, Math.max(0, item.dispatchAt - now));
      timer.unref?.();
      this.restartGateTimers.add(timer);
    }
    const deadline = setTimeout(() => {
      this.restartGateTimers.delete(deadline);
      if (this.restartGate.phase === "resuming") {
        backendRegistryLog.warn("restart gate opened at its deadline", {
          pending: [...this.restartGate.pending.keys()],
        });
      }
      this.applyRestartGate({ type: "deadline", at: Date.now() });
    }, Math.max(0, plan.releaseBy - now));
    deadline.unref?.();
    this.restartGateTimers.add(deadline);
  }

  /**
   * A continuation that starts, fails, is discarded, or is blocked or held
   * no longer holds the gate: a held one waits on the operator, who should
   * not wait on it. Its row goes when it leaves the queue; a blocked or held
   * one keeps its row, so a later restart sends it again.
   */
  private trackRestartContinuation(event: ThreadTurnQueueLifecycleEvent): void {
    const { entry } = event;
    if (event.type === "started" || event.type === "failed" || event.type === "cancelled") {
      this.forgetRestartContinuation(entry.id);
    }
    if (entry.restartContinuation && restartContinuationSettles(event.type)) {
      this.applyRestartGate({ type: "settled", entryId: entry.id });
    }
  }

  /** The queued messages a quiet restart carries, in the order they wait. */
  private restartQueuedSnapshot(): StoredRestartContinuation[] {
    // The scheduler recovers lock holds unless the operator separately
    // paused the entry. The checkpoint owns that explicit pause.
    return this.threadTurnQueue.getAllQueuedEntries()
      .filter((entry) => !entry.restartContinuation && !entry.projectHold
        && !(!entry.paused && entry.holdReason && isThreadLockRefusal(entry.holdReason)
          && scheduledActionIdFromTurnQueueEntry(entry.id)))
      .map((entry, position) => {
        const verification = this.durableRestartContinuations.get(entry.id)?.upgradeVerification;
        return { ...storedRestartQueuedEntry(entry, position), ...(verification ? { upgradeVerification: verification } : {}) };
      });
  }

  /**
   * After the operator edits, pauses, resumes or reorders a saved queued
   * message, rewrites the saved copies so a second restart brings back what
   * the queue holds now. One commit, for the copies that changed; nothing
   * once every saved message has left the queue.
   */
  private refreshRestartQueuedEntries(): void {
    const store = this.restartContinuationStore;
    if (!store) return;
    const saved = this.restartQueuedSnapshot()
      .filter((entry) => this.durableRestartContinuations.get(entry.id)?.kind === "queued");
    if (saved.length === 0) return;
    try {
      store.saveAll(this.runtimeInstanceId, saved);
      for (const entry of saved) this.durableRestartContinuations.set(entry.id, entry);
    } catch (error) {
      backendRegistryLog.warn("restart queued messages were not refreshed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private forgetRestartContinuation(entryId: string): void {
    if (!this.restartContinuationStore || !this.durableRestartContinuations.has(entryId)) return;
    try {
      this.restartContinuationStore.remove(entryId);
      this.durableRestartContinuations.delete(entryId);
    } catch (error) {
      backendRegistryLog.warn("restart continuation could not be forgotten", {
        entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Every wake-up a paused project holds, across its threads. */
  listProjectHeldWakeups(directoryKey: string): ProjectHeldWakeup[] {
    return this.threadTurnQueue.getAllQueuedEntries()
      .flatMap((entry): ProjectHeldWakeup[] => {
        if (entry.projectHold?.directoryKey !== directoryKey) return [];
        const threadTitle = this.getCachedThreadSummary(entry)?.title.trim();
        return [{
          entryId: entry.id,
          backend: entry.backend,
          threadId: entry.threadId,
          ...(threadTitle ? { threadTitle } : {}),
          source: entry.projectHold.source,
          summary: entry.projectHold.summary,
          createdAt: entry.createdAt,
        }];
      })
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /**
   * The operator's answers from the resume dialog. `send` releases the entry
   * for normal dispatch, an operator action that is allowed while the
   * project is still paused; `discard` deletes it.
   */
  async resolveProjectHeldWakeups(
    request: ResolveProjectHeldWakeupsRequest,
  ): Promise<ResolveProjectHeldWakeupsResponse> {
    const results: ResolveProjectHeldWakeupsResponse["results"] = [];
    for (const resolution of request.resolutions) {
      const entry = this.threadTurnQueue.getQueuedEntries(resolution)
        .find((candidate) => candidate.id === resolution.entryId);
      if (entry?.projectHold?.directoryKey !== request.directoryKey) {
        results.push({ entryId: resolution.entryId, status: "not_found" });
        continue;
      }
      try {
        if (resolution.action === "discard") {
          const cancelled = this.cancelQueuedTurn(
            resolution.entryId,
            "Discarded while resuming forge activity.",
          );
          results.push({ entryId: resolution.entryId, status: cancelled ? "discarded" : "not_found" });
          continue;
        }
        const review = this.subAgentMonitorService.reviewQueuedTaskMonitorDispatch(entry);
        if (review) await review;
        const resumed = await this.setQueuedTurnPaused({
          queueEntryId: resolution.entryId,
          paused: false,
        }, (live) => this.subAgentMonitorService.projectHeldMonitorReleaseRefusal(live));
        results.push({
          entryId: resolution.entryId,
          status: resumed.disposition === "updated" ? "sent" : "not_found",
        });
      } catch (error) {
        results.push({
          entryId: resolution.entryId,
          status: error instanceof ThreadTurnQueueDispatchRefused ? "suppressed" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results };
  }

  submitTurnIfIdle(params: IdleSubmission & { joinRunningTurn: true }): Promise<JoinedSubmissionResult>;
  submitTurnIfIdle(params: IdleSubmission & { joinRunningTurn?: false }): Promise<ThreadTurnQueueImmediateSubmissionResult>;
  async submitTurnIfIdle(params: IdleSubmission & {
    /**
     * A PwrAgent wake (Continue After, a PR watch) joins a running turn, or
     * starts one, and shares its delivery with the agent and system messages
     * waiting beside it. A running turn no longer reads as busy; a lock, an
     * archive, a handoff, a workspace move or a checkout restore still does.
     */
    joinRunningTurn?: boolean;
  }): Promise<JoinedSubmissionResult> {
    this.assertThreadNotHandingOff(params.backend, params.threadId);
    const { origin = "manual", joinRunningTurn = false, ...entry } = params;
    const join = joinRunningTurn && isSteerableAgentTraffic(entry.messageOrigin);
    const overlay = await this.overlayStore.getThreadOverlayState({ backend: params.backend, threadId: params.threadId });
    // The durable archive observation also covers watches restored at startup,
    // before provider listings have populated this process's information store.
    const isArchived = () => this.getThreadInfo(params)?.archived
      ?? (overlay?.archiveRetentionStartedAt !== undefined || overlay?.archiveTombstonedAt !== undefined);
    if (
      // A lock reads as busy, not as a failure: the PR watch and auto-fix
      // callers wait without spending an attempt, and resume once unlocked.
      overlay?.lock
      // Retired PR work can still be in flight when archive completes.
      // Discard its admission without resuming the thread or cancelling cleanup.
      || isArchived()
      || (!join && this.threadHasActiveTurn(params.threadId, params.backend))
      || this.threadWorkspaceService.threadHasBlockingWorkspaceMove(params)
      || this.threadArchiveCoordinator.checkoutRestoreRecords.has(buildThreadIdentityKey(params.backend, params.threadId))
    ) {
      return { status: "busy" };
    }
    try {
      return await this.admitThreadAttachments(entry, (input, onAdmission): Promise<JoinedSubmissionResult> => {
        // Attachment preparation can yield to an archive notification.
        if (isArchived()) return Promise.resolve({ status: "busy" as const });
        return join
          ? this.threadTurnQueue.submitSteer({ ...entry, input, origin }, { onAdmission })
          : this.threadTurnQueue.submitIfIdle({
            ...entry,
            input,
            origin,
          }, { onAdmission });
      });
    } catch (error) {
      // Turn preparation yields after the queue's idle check. If a backend
      // notification claimed the thread meanwhile, preserve the busy result
      // so automations wait without spending their attempt reservations.
      if (error instanceof ThreadAlreadyActiveError || error instanceof CodexThreadBusyBeforeStartError) return { status: "busy" };
      throw error;
    }
  }

  async readQueuedTurn(
    request: ReadQueuedTurnRequest,
    portable = false,
  ): Promise<ReadQueuedTurnResponse> {
    const entry = this.threadTurnQueue.getQueuedEntries(request)
      .find((candidate) => candidate.id === request.queueEntryId);
    if (!entry) throw new Error("The queued message is no longer waiting.");
    return {
      queueEntryId: entry.id,
      contentHash: createHash("sha256").update(JSON.stringify(entry.input)).digest("hex"),
      input: portable
        ? await portableTurnInputAttachments(structuredClone(entry.input), {
            privateStorageRoots: this.localFilePrivateStorageRoots,
          })
        : request.forEdit
        ? await stageQueuedFileInputs(structuredClone(entry.input))
        : structuredClone(entry.input),
      imageParts: entry.input.flatMap((item): AppServerThreadImagePart[] => {
        if (item.type === "image") {
          return [{ type: "image", url: item.url, alt: item.name }];
        }
        if (item.type === "localImage") {
          return [{
            type: "image",
            url: toTranscriptImageProtocolUrl(pathToFileURL(item.path).toString()),
            alt: item.name,
          }];
        }
        return [];
      }),
      ...(entry.messageOrigin ? { messageOrigin: structuredClone(entry.messageOrigin) } : {}),
    };
  }

  cancelQueuedTurn(entryId: string, reason?: string): boolean {
    return Boolean(this.threadTurnQueue.cancelEntry(entryId, reason));
  }

  cancelQueuedTurnWithDisposition(
    entryId: string,
    reason?: string,
    expectedContentHash?: string,
  ): CancelQueuedTurnResponse {
    if (expectedContentHash) {
      const entry = this.threadTurnQueue.getAllQueuedEntries().find((entry) => entry.id === entryId);
      if (entry && createHash("sha256").update(JSON.stringify(entry.input)).digest("hex") !== expectedContentHash) {
        return { queueEntryId: entryId, cancelled: false, disposition: "content_changed" };
      }
    }
    const result = this.threadTurnQueue.cancelEntryWithDisposition(
      entryId,
      reason,
    );
    return {
      queueEntryId: entryId,
      cancelled: result.disposition === "cancelled",
      disposition: result.disposition,
      ...(result.disposition === "already_admitted" && result.turnId
        ? { turnId: result.turnId }
        : {}),
    };
  }

  /**
   * Moves a waiting entry within its thread's FIFO. Every window and viewer
   * re-reads the queue on `thread/turnQueue/reordered`; the order lives in
   * the in-memory FIFO only, so a move writes nothing to sqlite.
   */
  async moveQueuedTurn(
    request: Omit<MoveQueuedTurnRequest, "federationTarget">,
  ): Promise<MoveQueuedTurnResponse> {
    const result = await this.threadTurnQueue.moveEntry(
      request.queueEntryId,
      request.beforeQueueEntryId,
    );
    if (result.disposition === "moved" && result.backend && result.threadId) {
      this.refreshRestartQueuedEntries();
      await this.emit({
        backend: result.backend,
        notification: {
          method: "thread/turnQueue/reordered",
          params: {
            threadId: result.threadId,
            queueEntryIds: result.entryIds ?? [],
          },
        },
      }).catch((error) => {
        backendRegistryLog.error("Could not publish queued turn order", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return {
      queueEntryId: request.queueEntryId,
      disposition: result.disposition,
      ...(result.entryIds ? { queueEntryIds: result.entryIds } : {}),
    };
  }

  /**
   * Pauses or resumes a waiting entry. Every window and viewer hears the
   * entry's new state on `thread/turnQueue/updated`, as a title refresh is
   * heard; the flag lives on the in-memory FIFO entry, so it writes nothing
   * to sqlite.
   */
  async setQueuedTurnPaused(
    request: Omit<SetQueuedTurnPausedRequest, "federationTarget">,
    checkRelease?: (entry: ThreadTurnQueueEntry) => string | undefined,
  ): Promise<SetQueuedTurnPausedResponse> {
    const saved = this.durableRestartContinuations.get(request.queueEntryId);
    if (!request.paused && saved?.ownsScheduledTurn) {
      await this.assertThreadNotLocked(saved.backend, saved.threadId);
    }
    const result = await this.threadTurnQueue.setEntryPaused(
      request.queueEntryId,
      request.paused,
      checkRelease,
    );
    const entry = result.entry;
    // A control can retire or replace this row while the shared mutation
    // settles. Publish only its live state, including newer holds/revisions.
    const current = entry && this.threadTurnQueue.getQueuedEntries(entry)
      .find((candidate) => candidate.id === entry.id);
    if (result.disposition === "updated" && entry?.paused && !entry.projectHold) {
      // A sent wake-up the operator pauses again is an ordinary queued
      // message now; a restart must not bring it back as a project hold.
      // This completed Pause owns cleanup even if a later control resumed it.
      this.forgetDurableProjectHeldWakeup(entry.id);
    }
    if (result.disposition === "updated" && current) {
      this.refreshRestartQueuedEntries();
      await this.emit({
        backend: current.backend,
        notification: {
          method: "thread/turnQueue/updated",
          params: {
            threadId: current.threadId,
            queueEntryId: current.id,
            queueEntryCreatedAt: current.createdAt,
            origin: current.origin,
            status: current.manualReleaseRequired ? "held" : "queued",
            displayText: queuedTurnDisplayText(current.input),
            ...(current.title ? { title: current.title } : {}),
            manualReleaseRequired: current.manualReleaseRequired === true,
            ...queuedTurnPauseParams(current),
            ...(current.holdReason ? { errorMessage: current.holdReason } : {}),
          },
        },
      }).catch((error) => {
        backendRegistryLog.error("Could not publish queued turn pause", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return {
      queueEntryId: request.queueEntryId,
      disposition: result.disposition,
      ...(entry ? { paused: entry.paused === true } : {}),
      ...(entry?.pauseRevision ? { pauseRevision: entry.pauseRevision } : {}),
    };
  }

  async releaseQueuedTurnWithDisposition(
    entryId: string,
    expected?: Omit<ThreadTurnQueueEntry, "id" | "createdAt" | "delivery">,
  ): Promise<ReleaseQueuedTurnResponse> {
    const acceptance = expected ? {
      ...expected,
      input: await ownThreadInputAttachments(expected.input, expected, this.localFilePrivateStorageRoots),
    } : undefined;
    const entry = this.threadTurnQueue.getAllQueuedEntries().find((candidate) => candidate.id === entryId);
    if (entry?.delivery === "queued-steer" && entry.manualReleaseRequired && this.getActiveTurnForThread(entry)) {
      const backend = (await this.listBackends({ includeUnavailable: true })).backends
        .find((candidate) => candidate.kind === entry.backend);
      // The queue's live-owner check is optimistic. Confirm provider support
      // before Retry clears review holds, then recheck the live FIFO after IO.
      const head = this.threadTurnQueue.getQueuedEntries(entry).find((candidate) => !candidate.paused);
      if (!backend?.capabilities.steerTurn && head?.id === entryId
        && head.manualReleaseRequired && this.getActiveTurnForThread(head)) {
        return { queueEntryId: entryId, disposition: "busy" };
      }
    }
    const result = await this.threadTurnQueue.releaseEntryWithDisposition(entryId, acceptance);
    return {
      queueEntryId: entryId,
      disposition: result.disposition,
      ...(result.disposition === "started" ? { turnId: result.turnId } : {}),
      ...(result.disposition === "blocked"
        ? { errorMessage: result.error.message }
        : {}),
    };
  }

  async replaceQueuedAgentMessage(request: {
    backend: AppServerBackendKind;
    threadId: string;
    queueEntryId: string;
    input: AppServerTurnInputItem[];
    messageOrigin?: AppServerThreadMessageOrigin;
  }): Promise<StartTurnResponse & { queueStatus: "queued" }> {
    const input = await ownThreadInputAttachments(request.input, request, this.localFilePrivateStorageRoots);
    // The shared replacement rechecks waiting identity and sender ownership
    // after earlier FIFO controls settle, then cancels before fresh admission.
    const sender = request.messageOrigin?.sourceThread;
    const entry = this.threadTurnQueue.getQueuedEntries(request)
      .find((candidate) => candidate.id === request.queueEntryId);
    if (!entry) throw new Error("Queued message not found or already started; no new turn was created.");
    // Only an older build's restart save can still hold a batch: one entry
    // carrying several senders' messages. Its id covers other senders' input.
    if (entry.agentMessageOrigins) {
      throw new Error("This message waits in a batch with other senders' messages and cannot be replaced. Send a new message instead.");
    }
    const owner = entry.messageOrigin?.sourceThread;
    if (
      entry.messageOrigin?.kind !== "agent"
      || request.messageOrigin?.kind !== "agent"
      || !sender
      || !owner
      || owner.backend !== sender.backend
      || owner.threadId !== sender.threadId
      || owner.instanceId !== sender.instanceId
    ) {
      throw new Error("Only the sending thread can replace its own queued agent message.");
    }
    if (!request.input.some((item) => item.type === "text" && item.text.trim())) {
      throw new Error("Replacement input requires a non-empty prompt.");
    }
    // The operator approved the text they saw, so its approval stays with it.
    if (
      Boolean(request.messageOrigin.operatorApproved)
      !== Boolean(entry.messageOrigin.operatorApproved)
    ) {
      throw new Error(
        "A replacement cannot change whether the operator approved the queued message. Send a new message instead.",
      );
    }
    // The replacement is submitted again under the settings the entry keeps,
    // so it meets the thread's access as it stands now.
    await this.assertAgentMessageWithinThreadAccess({
      backend: request.backend,
      threadId: request.threadId,
      executionMode: entry.executionMode,
      approvalPolicy: entry.approvalPolicy,
      sandbox: entry.sandbox,
      messageOrigin: request.messageOrigin,
    });
    const updated = await this.threadTurnQueue.replaceQueuedAgentInput(request.queueEntryId, input, sender, request.messageOrigin);
    if (!updated) throw new Error("The sender's queued message is no longer waiting.");
    return {
      backend: updated.backend,
      threadId: updated.threadId,
      turnId: updated.id,
      queueStatus: "queued",
      queueEntryId: updated.id,
    };
  }

  updateQueuedTurnInput(
    entryId: string,
    input: AppServerTurnInputItem[],
  ): void {
    const entry = this.threadTurnQueue.updateQueuedEntryInput(entryId, input);
    if (!entry) return;
    this.emitQueuedTurnInputUpdated(entry);
  }

  private emitQueuedTurnInputUpdated(entry: ThreadTurnQueueEntry): void {
    this.refreshDurableProjectHeldWakeup(entry);
    this.refreshRestartQueuedEntries();
    this.requestQueuedMessageTitle(entry);
    // This is an input refresh, not another queue admission. In particular,
    // do not replay sender correspondence lifecycle transitions.
    void this.emit({
      backend: entry.backend,
      notification: {
        method: "thread/turnQueue/updated",
        params: {
          threadId: entry.threadId,
          queueEntryId: entry.id,
          queueEntryCreatedAt: entry.createdAt,
          origin: entry.origin,
          status: "queued",
          inputUpdated: true,
          displayText: queuedTurnDisplayText(entry.input),
          manualReleaseRequired: entry.manualReleaseRequired === true,
          ...queuedTurnPauseParams(entry),
          ...(entry.holdReason ? { errorMessage: entry.holdReason } : {}),
        },
      },
    }).catch((error) => {
      backendRegistryLog.error("Could not publish queued input update", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private requestQueuedMessageTitle(entry: ThreadTurnQueueEntry): void {
    // This helper currently supports Codex only. A Claude or ACP message
    // must not start a turn on a different provider just to label its queue.
    if (entry.backend !== "codex") {
      return;
    }
    const source = queuedMessageTitleSource(entry.input);
    if (!source) {
      this.queuedMessageTitler.forget(entry.id);
      return;
    }
    const context = queuedMessageTitleContext({
      origins: entry.agentMessageOrigins ?? [entry.messageOrigin],
      recipientTitle: this.threadInfoStore.getTitle({
        backend: entry.backend,
        threadId: entry.threadId,
      }),
      lookupTitle: (identity) => this.threadInfoStore.getTitle(identity),
    });
    this.queuedMessageTitler.request({
      entryId: entry.id,
      backend: entry.backend,
      threadId: entry.threadId,
      source,
      ...(context ? { context } : {}),
    });
  }

  /** Whether the entry is still queued and still holds the titled text. */
  private isQueuedMessageTitleCurrent(request: QueuedMessageTitleRequest): boolean {
    const current = this.threadTurnQueue
      .getAllQueuedEntries()
      .find((entry) => entry.id === request.entryId);
    return current !== undefined
      && queuedMessageTitleSource(current.input) === request.source;
  }

  /**
   * Lands a generated title on its entry if the entry is still queued and
   * still holds the text the title was written from, then refreshes every
   * window's row the way an input edit does.
   */
  private applyQueuedMessageTitle(
    request: QueuedMessageTitleRequest,
    title: string,
  ): boolean {
    if (!this.isQueuedMessageTitleCurrent(request)) return false;
    const entry = this.threadTurnQueue.setQueuedEntryTitle(request.entryId, title);
    if (!entry) return false;
    this.refreshRestartQueuedEntries();
    void this.emit({
      backend: entry.backend,
      notification: {
        method: "thread/turnQueue/updated",
        params: {
          threadId: entry.threadId,
          queueEntryId: entry.id,
          queueEntryCreatedAt: entry.createdAt,
          origin: entry.origin,
          status: entry.manualReleaseRequired ? "held" : "queued",
          displayText: queuedTurnDisplayText(entry.input),
          title,
          manualReleaseRequired: entry.manualReleaseRequired === true,
          ...queuedTurnPauseParams(entry),
          ...(entry.holdReason ? { errorMessage: entry.holdReason } : {}),
        },
      },
    }).catch((error) => {
      backendRegistryLog.error("Could not publish queued message title", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  /**
   * Shows a finished title run on the thread's "Name queued messages" row and
   * charges its usage to the thread as a system helper, the way thread naming
   * does. Only finished runs are written, with no running state in between:
   * a title costs two commits (the row and its usage line), not three.
   */
  private async recordQueuedMessageTitle(
    request: QueuedMessageTitleRequest,
    settlement: QueuedMessageTitleSettlement,
  ): Promise<void> {
    const { result } = settlement;
    // No helper ran, so there is nothing to show and nothing to charge.
    if (result.status === "unavailable") return;
    const now = Date.now();
    const monitorId = queuedMessageTitleHelperSubAgentId(
      request.backend,
      request.threadId,
    );
    const existing = await this.overlayStore.getThreadSubAgent({
      backend: request.backend,
      threadId: request.threadId,
      monitorId,
    });
    const ok = result.status === "ok" ? result : undefined;
    const runUsage = ok?.tokenUsage
      ? buildTaskMonitorUsageSnapshot({
          model: ok.model,
          serviceTier: ok.serviceTier,
          tokenUsage: ok.tokenUsage,
        })
      : undefined;
    const monitorUsage = addTaskMonitorUsageSnapshots(existing?.monitorUsage, runUsage);
    const succeeded = settlement.title !== undefined;
    const preferredModel = ok?.model ?? existing?.preferredModel;
    const preferredReasoningEffort =
      ok?.reasoningEffort ?? existing?.preferredReasoningEffort;
    const subAgent: ThreadSubAgentSummary = {
      monitorId,
      task: "Name queued messages",
      attemptId: randomUUID(),
      status: succeeded ? "success" : "failed",
      // Each run is a new attempt, so the card's timing is the latest run's.
      createdAt: settlement.startedAt,
      updatedAt: now,
      ownerRuntimeInstanceId: this.runtimeInstanceId,
      ownerRegistrySessionId: this.registrySessionId,
      backend: request.backend,
      agentName: "PwrAgent",
      ...(preferredModel ? { preferredModel } : {}),
      ...(preferredReasoningEffort ? { preferredReasoningEffort } : {}),
      ...(ok?.helperThreadId ? { monitorThreadId: ok.helperThreadId } : {}),
      ...(ok?.helperTurnId ? { monitorTurnId: ok.helperTurnId } : {}),
      lastMessage: queuedMessageTitleHelperSubAgentMessage({
        count: queuedMessageTitleHelperCount(existing) + (settlement.applied ? 1 : 0),
        settlement,
      }),
      outcome: succeeded ? "success" : "failure",
      completedAt: now,
      completionSource: {
        type: "pwragent_fallback",
        reason: "system_queued_message_title_helper",
        recoveryAttempted: false,
        terminalStatus: succeeded ? "completed" : "failed",
      },
      ...(monitorUsage ? { monitorUsage } : {}),
    };
    await this.writeSystemHelperSubAgent({
      backend: request.backend,
      threadId: request.threadId,
      subAgent,
      ...(ok && runUsage ? { usage: { result: ok, snapshot: runUsage } } : {}),
    });
  }

  /** Resolves once queued-message titles in flight have landed. Tests only. */
  async queuedMessageTitlesIdle(): Promise<void> {
    await this.queuedMessageTitler.idle();
  }

  canStartThreadTurnImmediately(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): boolean {
    return (
      !this.threadHasActiveTurn(params.threadId, params.backend)
      && this.threadTurnQueue.canStartImmediately(params)
    );
  }

  getActiveTurnForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): { backend: AppServerBackendKind; threadId: string; turnId: string } | undefined {
    const review = this.managedReviewService.findReviewForParentTurn({
      backend: params.backend,
      parentThreadId: params.threadId,
    });
    if (review) {
      return { ...params, turnId: review.turnId };
    }
    if (params.backend === "codex") {
      for (const key of this.context.turnState.executionKeys()) {
        const parsed = parseThreadTurnKeyBody(key);
        if (
          parsed?.threadId === params.threadId &&
          !parsed.turnId.startsWith("pending:")
        ) {
          return {
            backend: params.backend,
            threadId: parsed.threadId,
            turnId: parsed.turnId,
          };
        }
      }
      return undefined;
    }

    for (const key of this.context.turnState.registeredTurnKeys()) {
      const parsed = parseActiveTurnKey(key);
      if (
        parsed?.backend === params.backend &&
        parsed.threadId === params.threadId
      ) {
        return parsed;
      }
    }
    return undefined;
  }

  isThreadTurnOccupied(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): boolean {
    return this.threadHasActiveTurn(params.threadId, params.backend);
  }

  private getPendingTurnForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): { backend: AppServerBackendKind; threadId: string; turnId: string } | undefined {
    if (params.backend === "codex") {
      for (const key of this.context.turnState.executionKeys()) {
        const parsed = parseThreadTurnKeyBody(key);
        if (
          parsed?.threadId === params.threadId
          && parsed.turnId.startsWith("pending:")
        ) {
          return {
            backend: params.backend,
            threadId: parsed.threadId,
            turnId: parsed.turnId,
          };
        }
      }
      return undefined;
    }

    for (const key of this.context.turnState.registeredTurnKeys()) {
      const parsed = parseActiveTurnKey(key);
      if (
        parsed?.backend === params.backend
        && parsed.threadId === params.threadId
        && parsed.turnId.startsWith("pending:")
      ) {
        return parsed;
      }
    }
    return undefined;
  }

  /**
   * Navigation and shutdown share runtime worker ownership, never durable
   * history. Claude background tasks that outlive a turn mark the row as
   * working, because Claude takes another turn when one finishes. Codex
   * background terminals mark it with a running command instead. The quit
   * prompt counts both.
   */
  withNavigationSubAgentActivity(
    threads: NavigationThreadSummary[],
  ): NavigationThreadSummary[] {
    const activeOwners = new Set(this.getInProgressThreadSnapshot().subAgentThreadKeys);
    const backgroundTaskOwners = new Set(
      this.claudeBackend
        .backgroundTaskThreadIds()
        .map((threadId) => buildThreadIdentityKey("claude", threadId)),
    );
    // A Codex terminal never wakes the agent when it exits, so it marks the
    // row with a running command rather than as working.
    const agentCommandOwners = new Set(
      [...this.codexRuntimeSupervisor.backgroundTerminalRecords.keys()].map((threadId) => buildThreadIdentityKey("codex", threadId)),
    );
    return threads.map((thread) => {
      if (thread.federation) return thread;
      const key = buildThreadIdentityKey(thread.source, thread.id);
      const hasActiveSubAgent = activeOwners.has(key);
      const hasBackgroundTasks = backgroundTaskOwners.has(key);
      const hasAgentCommands = agentCommandOwners.has(key);
      if (
        thread.hasActiveSubAgent === hasActiveSubAgent
        && Boolean(thread.hasBackgroundTasks) === hasBackgroundTasks
        && Boolean(thread.hasAgentCommands) === hasAgentCommands
      ) return thread;
      const { hasBackgroundTasks: _previous, hasAgentCommands: _previousCommands, ...rest } = thread;
      return {
        ...rest,
        hasActiveSubAgent,
        ...(hasBackgroundTasks ? { hasBackgroundTasks: true } : {}),
        ...(hasAgentCommands ? { hasAgentCommands: true } : {}),
      };
    });
  }

  getInProgressThreadSnapshotForQuit() {
    return this.getInProgressThreadSnapshot();
  }

  /** On-demand only: no timers, persistence, tool arguments, or transcript text. */
  getQuitBlockerDiagnostics() {
    const contributors: Record<string, unknown>[] = [];
    const sourceCounts: Record<string, number> = {};
    let omittedContributors = 0;
    let bytes = 0;
    const bounded = (value: string) => value.slice(0, 100);
    this.getInProgressThreadSnapshot((entry) => {
      sourceCounts[entry.source] = (sourceCounts[entry.source] ?? 0) + 1;
      if (contributors.length >= 20) {
        omittedContributors += 1;
        return;
      }
      const tools = entry.source === "live-tool-items"
        ? this.codexRuntimeSupervisor.liveToolItemRecords.get(entry.threadId)
        : undefined;
      const terminals = entry.source === "background-terminals"
        ? this.codexRuntimeSupervisor.backgroundTerminalRecords.get(entry.threadId)
        : undefined;
      const detail = {
        threadKey: bounded(entry.threadKey),
        sourceThreadId: bounded(entry.threadId),
        source: entry.source,
        sourceBackend: entry.backend,
        ...(entry.turnId ? { turnId: bounded(entry.turnId) } : {}),
        ...(entry.backend === "codex" ? {
          observedStatus: this.context.turnState.statusObservation(entry.threadId)?.status,
        } : {}),
        ...(tools ? {
          itemCount: tools.size,
          items: (() => {
            const sample = [];
            for (const [itemId, item] of tools) {
              sample.push({
                itemId: bounded(itemId), turnId: bounded(item.turnId),
                type: bounded(item.itemType), turnEnded: Boolean(item.turnEnded),
              });
              if (sample.length === 4) break;
            }
            return sample;
          })(),
        } : {}),
        ...(terminals ? {
          terminalCount: terminals.length,
          terminals: terminals.slice(0, 4).map((terminal) => ({
            itemId: bounded(terminal.itemId), processId: bounded(terminal.processId),
          })),
        } : {}),
      };
      const size = Buffer.byteLength(JSON.stringify(detail), "utf8");
      // Leave room for the fixed source counts and omission counters within
      // an 8 KiB log field, even with non-ASCII protocol identifiers.
      if (bytes + size > 6_500) {
        omittedContributors += 1;
        return;
      }
      contributors.push(detail);
      bytes += size;
    });
    return { sourceCounts, contributors, omittedContributors };
  }

  private getInProgressThreadSnapshot(onSource?: (entry: QuitThreadSource) => void): {
    count: number;
    threadIds: string[];
    subAgentThreadKeys?: string[];
    threadTitles?: Record<string, string>;
    automationRuns?: Array<{
      agentThreadId: string;
      automationName?: string;
      automationRunId: string;
      backend: AppServerBackendKind;
      startedAt: number;
    }>;
  } {
    const threadKeys = new Set<string>();
    const subAgentThreadKeys = new Set<string>();
    const threadTitles = new Map<string, string>();
    const automationExecutionThreadKeys = new Set<string>();
    const automationRunsByKey = new Map<
      string,
      {
        agentThreadId: string;
        automationName?: string;
        automationRunId: string;
        backend: AppServerBackendKind;
        startedAt: number;
      }
    >();
    for (const run of this.headlessAutomation.runningTurns()) {
      automationExecutionThreadKeys.add(
        formatQuitThreadKey(run.backend, run.executionThreadId),
      );
      const key = `${run.backend}:${run.automationRunId}`;
      const existing = automationRunsByKey.get(key);
      if (!existing || run.startedAt < existing.startedAt) {
        automationRunsByKey.set(key, {
          agentThreadId: run.agentThreadId,
          automationName: run.automationName,
          automationRunId: run.automationRunId,
          backend: run.backend,
          startedAt: run.startedAt,
        });
      }
    }
    const addThread = (backend: AppServerBackendKind, threadId: string, source: string, turnId?: string): void => {
      const owner = this.subAgentMonitorService.resolveSubAgentThreadOwner({ backend, threadId });
      const threadKey = formatQuitThreadKey(owner.backend, owner.threadId);
      if (!automationExecutionThreadKeys.has(threadKey)) {
        onSource?.({ backend, threadId, threadKey, source, turnId });
        threadKeys.add(threadKey);
        if (owner.isSubAgent) {
          subAgentThreadKeys.add(threadKey);
        }
        const title = this.cachedQuitThreadTitle(owner.backend, owner.threadId);
        if (title) {
          threadTitles.set(threadKey, title);
        }
      }
    };
    for (const threadId of this.context.turnState.providerActiveThreadIds()) {
      addThread("codex", threadId, "backend-active");
    }
    for (const threadId of this.codexRuntimeSupervisor.backgroundTerminalRecords.keys()) {
      addThread("codex", threadId, "background-terminals");
    }
    // A Claude session outlives its turn while background tasks run.
    for (const threadId of this.claudeBackend.liveSessionThreadIds()) {
      addThread("claude", threadId, "live-session");
    }
    for (const threadId of this.codexRuntimeSupervisor.liveToolItemRecords.keys()) {
      addThread("codex", threadId, "live-tool-items");
    }
    for (const key of this.context.turnState.registeredTurnKeys()) {
      const parsed = parseActiveTurnKey(key);
      if (parsed) {
        addThread(parsed.backend, parsed.threadId, "active-turn", parsed.turnId);
      }
    }
    for (const key of this.context.turnState.executionKeys()) {
      const threadId = parseThreadIdFromThreadTurnKeyBody(key);
      if (threadId) {
        addThread("codex", threadId, "turn-mode", parseThreadTurnKeyBody(key)?.turnId);
      }
    }
    for (const threadId of this.context.turnState.startReservationThreadIds()) {
      addThread("codex", threadId, "start-reservation");
    }
    for (const key of this.reservedAcpStartThreadKeys) {
      const parsed = parseReservedAcpStartThreadKey(key);
      if (parsed) {
        addThread(parsed.backend, parsed.threadId, "start-reservation");
      }
    }
    for (const entry of this.threadTurnQueue.getAllQueuedEntries()) {
      addThread(entry.backend, entry.threadId, "queued-turn");
    }
    for (const move of this.threadWorkspaceService.pendingThreadWorkspaceMoveRecords.values()) {
      if (move.status === "queued" || move.status === "running") {
        addThread(move.backend, move.threadId, "workspace-move");
      }
    }
    const threadIds = [...threadKeys].sort();
    const automationRuns = [...automationRunsByKey.values()].sort(
      (left, right) =>
        left.startedAt - right.startedAt
        || left.automationRunId.localeCompare(right.automationRunId),
    );
    return {
      count: threadIds.length + automationRuns.length,
      threadIds,
      ...(subAgentThreadKeys.size > 0
        ? { subAgentThreadKeys: [...subAgentThreadKeys].sort() }
        : {}),
      ...(threadTitles.size > 0
        ? { threadTitles: Object.fromEntries(threadTitles) }
        : {}),
      ...(automationRuns.length > 0 ? { automationRuns } : {}),
    };
  }

  /** Cached only: quit must never wait for a provider round trip to name work. */
  private cachedQuitThreadTitle(
    backend: AppServerBackendKind,
    threadId: string,
  ): string | undefined {
    return this.threadInfoStore.getTitle({ backend, threadId });
  }

  async supportsMessagingPdfTools(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<boolean> {
    if (params.backend !== "codex") {
      return false;
    }
    const overlay = await this.overlayStore.getThreadOverlayState(params);
    return this.resolvePdfAnalysisEnabledFn() && this.hasPdfMcpToolCatalog(overlay);
  }

  private hasPdfMcpToolCatalog(overlay: ThreadOverlayState | undefined): boolean {
    return (
      overlay?.messagingPdfToolCatalogVersion !== undefined &&
      overlay.messagingPdfToolCatalogVersion >=
        PWRAGENT_MESSAGING_PDF_TOOL_CATALOG_VERSION
    );
  }

  private resolvePdfTurnInputHandling(params: {
    backend: AppServerBackendKind;
    overlay?: ThreadOverlayState;
    pdfMcpAvailable?: boolean;
  }): PdfTurnInputHandling {
    if (!this.resolvePdfAnalysisEnabledFn()) {
      return "pass_through";
    }
    return (
      params.backend === "codex"
      && params.pdfMcpAvailable === true
      && this.hasPdfMcpToolCatalog(params.overlay)
    )
      ? "model_directed"
      : "render_initial_pages";
  }

  private async registerPdfMcpClient(params: {
    threadId?: string;
  }): Promise<AgentToolMcpRegistration | undefined> {
    if (!this.pdfToolMcpServer) {
      return undefined;
    }
    // The PDF server's tools run in the owner like dynamic tools, so a host
    // that restricts agent tools offers it only when the grant covers every
    // one of them. An empty list proves nothing about what the server
    // resolves per call, so it fails closed. The server also refuses each
    // unlisted call, for a thread that started before this member was
    // contained.
    const agentToolAllowlist = localAgentToolAllowlist();
    if (agentToolAllowlist) {
      const pdfTools = buildPwrAgentMessagingPdfToolRouter(this.messagingHandler).buildDynamicToolSpecs();
      const pdfToolCount = countAgentTools(pdfTools);
      if (
        pdfToolCount === 0
        || countAgentTools(filterAdvertisedAgentTools(agentToolAllowlist, pdfTools)) !== pdfToolCount
      ) {
        return undefined;
      }
    }
    try {
      return await this.pdfToolMcpServer.registerClient({
        backend: "codex",
        ...(params.threadId ? { threadId: params.threadId } : {}),
      });
    } catch (error) {
      backendRegistryLog.warn("pdf_mcp_start_failed", {
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId ?? null,
      });
      return undefined;
    }
  }

  async startTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    executionMode?: ThreadExecutionMode;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    messageOrigin?: AppServerThreadMessageOrigin;
  }, turnInputSource?: TurnInputSource): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    this.assertThreadOwnership();
    await this.assertThreadCodexInferenceAvailable(params);
    await this.threadModelSettings.assertRequestedThreadModelAvailable(params);
    const result = await this.startTurnNow({ ...params, turnInputSource });
    await this.publishIncomingWork({ ...params, threadId: result.threadId }, result.turnId);
    return result;
  }

  private async publishIncomingWork(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    messageOrigin?: AppServerThreadMessageOrigin;
  }, turnId: string, recipientTitle = this.getCachedThreadSummary(params)?.title): Promise<void> {
    const incomingWork = buildIncomingWorkSummary(params, recipientTitle);
    if (incomingWork) await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/incomingWork",
        params: {
          threadId: params.threadId,
          turnId,
          deliveryId: `start:${turnId}`,
          incomingWork,
        },
      },
    }).catch((error) => {
      backendRegistryLog.warn("Could not publish incoming thread work", { error: String(error) });
    });
  }

  private async startTurnNow(params: {
    id?: string;
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin?: ThreadTurnQueueOrigin;
    turnInputSource?: TurnInputSource;
    executionMode?: ThreadExecutionMode;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    messageOrigin?: AppServerThreadMessageOrigin;
    agentMessageOrigins?: AppServerThreadMessageOrigin[];
    agentMessages?: ThreadTurnQueueEntry["agentMessages"];
    invalidIdRecoveryAttempted?: boolean;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    assertOwnerExecutionPolicy(getOwnerHostServices().runtimePolicy, params);
    await this.assertThreadCodexInferenceAvailable(params);
    if (params.id && scheduledActionIdFromTurnQueueEntry(params.id)
      && this.durableRestartContinuations.has(params.id)) {
      await this.assertThreadNotLocked(params.backend, params.threadId);
    }
    return await listingDiagnostics.trace("workflow", { query: "submit-acceptance" }, () => this.prepareAndStartTurn(params));
  }

  private async prepareAndStartTurn(params: Parameters<DesktopBackendRegistry["startTurnNow"]>[0]): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    this.assertThreadOwnership();
    return await this.threadStarts.run(params, () => this.startTurnWithoutHandoff(params));
  }

  private async startTurnWithoutHandoff(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin?: ThreadTurnQueueOrigin;
    turnInputSource?: TurnInputSource;
    executionMode?: ThreadExecutionMode;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    messageOrigin?: AppServerThreadMessageOrigin;
    agentMessageOrigins?: AppServerThreadMessageOrigin[];
    agentMessages?: ThreadTurnQueueEntry["agentMessages"];
    invalidIdRecoveryAttempted?: boolean;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    this.threadArchiveCoordinator.assertArchiveWorkspaceUsable(buildThreadIdentityKey(params.backend, params.threadId));
    if (!this.tokenMiserServerCapabilitiesForTurn.getStore()) {
      return await this.tokenMiserServerCapabilitiesForTurn.run(
        new WeakMap(),
        async () => await this.startTurnNow(params),
      );
    }
    this.assertNotBootstrap("startTurn");
    if (this.closed) {
      throw new Error("Desktop backend registry is closed");
    }
    if (params.backend === "codex" && !params.invalidIdRecoveryAttempted) {
      await this.codexRuntimeSupervisor.invalidIdRecoveryBarrier;
      if (this.closed) {
        throw new Error("Desktop backend registry closed before turn start");
      }
    }
    if (params.backend === "claude") {
      const overlay = await this.overlayStore.getThreadOverlayState(params);
      const modelSettings = await this.resolveModelSettings("claude", {
        model: params.model ?? overlay?.model,
        reasoningEffort: params.reasoningEffort ?? overlay?.reasoningEffort,
      });
      const input = await ownThreadInputAttachments(await enrichLocalFileInputs(params.input, {
        privateStorageRoots: this.localFilePrivateStorageRoots,
      }), params, this.localFilePrivateStorageRoots);
      const registrations = await this.threadMcpConnections.registerMcpConnections(overlay?.mcpConnectionIds, params.threadId, params.backend);
      let prepared!: Parameters<ClaudeBackend["startTurn"]>[0];
      return await this.threadStarts.startClaude({
        prepare: async () => {
          for (const registration of registrations) registration.bindThread(params.threadId);
          // As for ACP, PwrAgent's own tools are optional: a server that cannot
          // start must not block the operator's turn.
          const owned = await this.claudeAgentToolMcpServer?.registerClient({ backend: "claude", threadId: params.threadId })
            .catch((error: unknown) => {
              backendRegistryLog.warn("agent_tool_mcp_start_failed", {
                backend: "claude",
                error: error instanceof Error ? error.message : String(error),
                threadId: params.threadId,
              });
              return undefined;
            });
          const servers = [...registrations.map((registration) => ({
            ...registration.server, name: buildCodexConnectionMcpServerName(registration.server),
          })), ...(owned ? [owned.server] : [])];
          const mcpServers = Object.fromEntries(servers.map((server) => [server.name, "url" in server
            ? { type: "http" as const, url: server.url, headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) }
            : { type: "stdio" as const, command: server.command, args: server.args, env: server.env }]));
          const instructions = providerDeliveredAgentInstructions(await this.getThreadAgentMetadata(params));
          const messageOrigin = resolveThreadMessageOrigin(params);
          prepared = {
            ...params, input, model: modelSettings.model, reasoningEffort: modelSettings.reasoningEffort,
            messageOrigin,
            executionMode: params.executionMode ?? overlay?.executionMode,
            instructions,
            readAgentMemory: this.readAgentMemoryContext.bind(this, { backend: params.backend, threadId: params.threadId }),
            mcpServers,
            ...(this.subAgentMonitorService.taskMonitorForThread(params) ? { strictMcpConfig: true } : {}),
            // PwrAgent's server lists tools by this member's containment.
            ...(owned ? { agentToolCatalogKey: localMemberRole() } : {}),
            // Directories attached to the thread, so Claude can work in them too.
            attachedDirectories: overlay?.extraLinkedDirectories,
            shellEnvironment: setupVariablesForAgent(
              overlay?.codexEnvironmentRuntime,
              this.resolvePassSetupVariablesToAgentsFn(),
            ),
          };
        },
        beginOrigin: () => this.beginStartingTurnOrigin({
          backend: params.backend, threadId: params.threadId,
          origin: prepared.messageOrigin, turnInputSource: resolveTurnInputSource(params),
        }),
        submit: async (onSessionClosed) => {
          try { return await this.claudeBackend.startTurn({ ...prepared, onSessionClosed }); }
          catch (error) {
            if (error instanceof ClaudeTurnActiveError) throw new ThreadAlreadyActiveError(error.message);
            throw error;
          }
        },
        bindOrigin: (origin, result) => this.bindStartingTurnOrigin(origin, result),
        persistOrigin: (origin) => this.persistStartingTurnOrigin(origin),
        disposeOrigin: (origin) => this.dropStartingTurnOrigin(origin),
        revokeConnections: () => { for (const registration of registrations) registration.revoke(); },
        failed: (stage, error, turn) => backendRegistryLog.warn("claude_turn_start_finalization_failed", {
          backend: params.backend, threadId: params.threadId, turnId: turn?.turnId, stage,
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }
    // A selection already in flight must finish before this turn reads its runtime.
    await this.threadDirectoryService.withCodexEnvironmentRuntimeLock(
      params.backend,
      params.threadId,
      async () => {},
    );
    const migrationResult = await this.applyThreadModelMigration({
      backend: params.backend,
      threadId: params.threadId,
    });
    const migrationApplied = migrationResult.status === "applied";
    if (isAcpBackendId(params.backend)) {
      const overlay = await this.overlayStore.getThreadOverlayState({
        backend: params.backend,
        threadId: params.threadId,
      });
      const pendingManagedReviewContextEntryIds =
        overlay?.pendingManagedReviewContextEntryIds ?? [];
      const managedReviewEntriesById = new Map(
        (overlay?.managedReviewEntries ?? []).map((entry) => [entry.id, entry]),
      );
      const pendingManagedReviewContexts =
        pendingManagedReviewContextEntryIds.flatMap((entryId) => {
          const entry = managedReviewEntriesById.get(entryId);
          if (!entry) {
            return [];
          }
          return [entry.output ? JSON.stringify(entry.output) : entry.review];
        });
      const modelSettings = await this.resolveModelSettings(params.backend, {
        model: migrationApplied
          ? overlay?.model
          : params.model ?? overlay?.model,
        reasoningEffort: migrationApplied
          ? overlay?.reasoningEffort
          : params.reasoningEffort ?? overlay?.reasoningEffort,
        reasoningEffortsByModel: overlay?.reasoningEffortsByModel,
      });
      const identity = { backend: params.backend, threadId: params.threadId };
      const reservationKey = buildTurnStartReservationKey(params.backend, params.threadId);
      let preparedPdfInput!: Awaited<ReturnType<typeof preparePdfTurnInput>>;
      let userInput!: AppServerTurnInputItem[];
      let input!: AppServerTurnInputItem[];
      return await this.threadStarts.startAcp({
        reserve: () => {
          if (this.threadHasActiveTurn(params.threadId, params.backend)) {
            throw new ThreadAlreadyActiveError("A turn is already active for this thread.");
          }
          this.reservedAcpStartThreadKeys.add(reservationKey);
        },
        prepare: async () => {
          preparedPdfInput = await preparePdfTurnInput({
            handling: this.resolvePdfTurnInputHandling({
              backend: params.backend,
              overlay,
            }),
            input: params.input,
          });
          // ACP adapters already accept data-URL image parts. Keeping those
          // intact avoids changing their established image payload contract.
          userInput = await ownThreadInputAttachments(
            await enrichLocalFileInputs(preparedPdfInput.input, {
              privateStorageRoots: this.localFilePrivateStorageRoots,
            }),
            params,
            this.localFilePrivateStorageRoots,
          );
          input = pendingManagedReviewContexts.length > 0
            ? [
                {
                  type: "text" as const,
                  text: buildManagedReviewContextInput(
                    pendingManagedReviewContexts,
                  ),
                },
                ...userInput,
              ]
            : userInput;
          if (this.usesSlashControlledAcpExecutionModes(params.backend)) {
            await this.flushQueuedExecutionModeIfPresent(
              params.threadId,
              params.backend,
            );
          }
          await this.acpSessionRuntimeOptions.flushQueuedAcpRuntimeOptionIfPresent(
            identity.backend,
            params.threadId,
          );
        },
        registerContext: () => this.registerPendingThreadMessageContext({
          ...identity, input,
          origin: resolveThreadMessageOrigin(params),
          text: extractFirstMeaningfulTextInput(params.input),
        }),
        beginOrigin: () => this.beginStartingTurnOrigin({
          ...identity, origin: resolveThreadMessageOrigin(params), turnInputSource: resolveTurnInputSource(params),
        }),
        submit: () => this.startAcpTurn({
          ...identity, input,
          model: modelSettings.model,
          reasoningEffort: modelSettings.reasoningEffort,
        }),
        bindOrigin: (origin, result) => this.bindStartingTurnOrigin(origin, result),
        consumeReviewContexts: () => this.overlayStore.consumeManagedReviewContexts({
          ...identity, entryIds: pendingManagedReviewContextEntryIds,
        }),
        bindPdf: (result) => this.pdfAttachmentStore.bindTurn(
          { backend: params.backend, threadId: result.threadId, turnId: result.turnId },
          preparedPdfInput.pdfAttachments,
        ),
        scheduleTitle: (result) => this.scheduleThreadTitleGeneration({
          backend: params.backend,
          threadId: result.threadId,
          input: userInput,
        }),
        bindContext: (context, result) => this.bindPendingThreadMessageContext(context, result.turnId),
        persistOrigin: (origin) => this.persistStartingTurnOrigin(origin),
        retainAttachments: (result) => this.rememberTurnInputAttachments({
          backend: params.backend,
          threadId: result.threadId,
          turnId: result.turnId,
          input: userInput,
        }),
        forgetContext: (context) => this.forgetPendingThreadMessageContext(context),
        disposeOrigin: (origin) => this.dropStartingTurnOrigin(origin),
        release: () => { this.reservedAcpStartThreadKeys.delete(reservationKey); },
        failed: (stage, error, turn) => backendRegistryLog.warn("acp_turn_start_finalization_failed", {
          ...identity, turnId: turn?.turnId, stage,
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }

    let input: AppServerTurnInputItem[] = [];
    let pdfAttachments!: PendingPdfAttachment[];
    const reserveCodexStart = params.backend === "codex";
    let startReservation: object | undefined;
    let overlay: ThreadOverlayState | undefined;
    let turnParams!: ModelSettings;
    let cwd: string | undefined;
    let activeTurnMode: ThreadExecutionMode | undefined;
    let codexThreadConfig: CodexThreadStartParams["config"] | undefined;
    let tokenMiserEnabledForThread = false;
    let codexStartObservation: { sequence: number; previous?: { sequence: number; status: AppServerThreadStatus } } | undefined;
    const { pendingTurnId: syntheticStartedTurnId, context: pendingMessageContextId } = await this.threadStarts.prepareCodex({
      threadId: params.threadId,
      reserve: (pendingTurnId) => {
        if (!reserveCodexStart) return;
        if (this.threadHasActiveTurn(params.threadId)) {
          throw new ThreadAlreadyActiveError("A turn is already active for this thread.");
        }
        startReservation = this.context.turnState.reserveStart(params.threadId, "turn");
        this.context.turnState.setCollaboration(
          { backend: "codex", threadId: params.threadId, turnId: pendingTurnId },
          params.collaborationMode?.mode ?? "default",
        );
      },
      prepare: async () => {
        if (params.backend === "codex") {
          await this.flushQueuedAgentChange(params.threadId, true);
          await this.flushQueuedExecutionModeIfPresent(params.threadId);
        }
        overlay = await this.overlayStore.getThreadOverlayState({
          backend: params.backend,
          threadId: params.threadId,
        });
        if (params.backend === "codex") {
          tokenMiserEnabledForThread = this.resolveTokenMiserEnabledForOverride(
            overlay?.tokenMiserEnabled,
          );
        }
        // Permission/agent changes above own the lifecycle boundary. Everything
        // here uses that resulting overlay; only input preparation needs the PDF
        // bridge result, and only config inventory needs the resolved cwd.
        const cwdPreparation =
          params.backend === "codex"
            ? this.resolveThreadEnvironmentCwd(
                params.backend,
                params.threadId,
                overlay,
              )
            : Promise.resolve(undefined);
        const runtimePreparation = tokenMiserEnabledForThread
          ? this.prepareTokenMiserRuntime()
          : Promise.resolve();
        const hasPdfMcpToolCatalog =
          params.backend === "codex" && this.hasPdfMcpToolCatalog(overlay);
        const pdfPreparation = hasPdfMcpToolCatalog && this.resolvePdfAnalysisEnabledFn()
          ? this.registerPdfMcpClient({ threadId: params.threadId })
          : Promise.resolve(undefined);
        // Re-read per turn so a mid-thread change to the selection or the
        // provider policy lands on the operator's next message.
        const isolateFromInherited =
          params.backend === "codex"
          && overlay?.mcpProviderServersEnabled === false;
        const connectionPreparation = (async () => {
          if (params.backend !== "codex" || !(overlay?.mcpConnectionIds?.length || isolateFromInherited)) return undefined;
          const [registrations, inheritedNames] = await joinConcurrent([
            this.threadMcpConnections.registerMcpConnections(overlay?.mcpConnectionIds ?? [], params.threadId, params.backend),
            cwdPreparation.then((resolvedCwd) => this.threadMcpConnections.readConfiguredCodexMcpServerNames(resolvedCwd)),
          ]);
          if (isolateFromInherited && inheritedNames === undefined) throw codexMcpIsolationUnavailableError();
          return buildCodexConnectionMcpConfig(registrations, inheritedNames, { isolateFromInherited });
        })();
        const inputPreparation = listingDiagnostics.trace("workflow", { query: "input-preparation" }, async () => {
          const registration = await pdfPreparation;
          const preparedPdfInput = await preparePdfTurnInput({
            handling: this.resolvePdfTurnInputHandling({ backend: params.backend, overlay, pdfMcpAvailable: registration !== undefined }),
            input: params.input,
          });
          const owned = await ownThreadInputAttachments(
            await enrichLocalFileInputs(preparedPdfInput.input, { privateStorageRoots: this.localFilePrivateStorageRoots }),
            params,
            this.localFilePrivateStorageRoots,
          );
          return { input: owned, pdfAttachments: preparedPdfInput.pdfAttachments };
        });
        const settingsPreparation = this.resolveModelSettings(params.backend, {
          ...params,
          ...(this.codexOpenAiProviderEnabled ? {} : {
            codexModelProviderId: this.codexClient.modelProviderForThread?.(params.threadId),
          }),
          model: migrationApplied
            ? overlay?.model
            : params.model ?? overlay?.model,
          serviceTier: params.serviceTier ?? overlay?.serviceTier,
          reasoningEffort: migrationApplied
            ? overlay?.reasoningEffort
            : params.reasoningEffort ?? overlay?.reasoningEffort,
          fastMode: params.backend === "codex" ? params.fastMode ?? overlay?.fastMode : undefined,
        });
        const [, connectionConfig, preparedInput, settings, resolvedCwd, pdfRegistration] = await joinConcurrent([
          runtimePreparation, connectionPreparation, inputPreparation, settingsPreparation, cwdPreparation, pdfPreparation,
        ]);
        cwd = resolvedCwd;
        turnParams = settings;
        input = preparedInput.input;
        pdfAttachments = preparedInput.pdfAttachments;
        codexThreadConfig = mergeCodexThreadConfigs(
          hasPdfMcpToolCatalog ? (pdfRegistration ? buildCodexPdfMcpConfig(pdfRegistration) : buildCodexPdfMcpDisabledConfig()) : undefined,
          connectionConfig,
        );
      },
      announce: (pendingTurnId) => {
        codexStartObservation = { sequence: this.reserveCodexThreadStatusObservationSequence(),
          previous: this.context.turnState.statusObservation(params.threadId) };
        return this.emit(buildTurnStartEvent(params, pendingTurnId), codexStartObservation.sequence);
      },
      rememberInput: () => this.threadTitles.rememberPendingInput(params, input),
      registerContext: () => this.registerPendingThreadMessageContext({
        backend: params.backend,
        input,
        threadId: params.threadId,
        origin: resolveThreadMessageOrigin(params),
        text: extractFirstMeaningfulTextInput(input),
      }),
      forgetContext: (context) => this.forgetPendingThreadMessageContext(context),
      fail: async (pendingTurnId, error, announced) => {
        if (announced) await this.emit(buildTurnStartFailureEvent(params, pendingTurnId, error), codexStartObservation?.sequence);
        else await this.managedReviewService.drainPendingReviewStartsForTerminalTurn({
          backend: params.backend,
          threadId: params.threadId,
          turnId: pendingTurnId,
          method: "turn/failed",
        });
      },
      retire: (pendingTurnId) => this.retireCodexTurnStart(params, pendingTurnId, startReservation, codexStartObservation),
    });
    const retryableCodexTurnStart: CodexRetryableTurnStart | undefined =
      params.backend === "codex" && !params.invalidIdRecoveryAttempted
        ? {
            kind: "turn",
            turnId: syntheticStartedTurnId,
            params: {
              backend: "codex",
              threadId: params.threadId,
              input: params.input,
              origin: params.origin,
              turnInputSource: params.turnInputSource,
              executionMode: params.executionMode,
              approvalPolicy: params.approvalPolicy,
              sandbox: params.sandbox,
              model: params.model,
              collaborationMode: params.collaborationMode,
              serviceTier: params.serviceTier,
              reasoningEffort: params.reasoningEffort,
              fastMode: params.fastMode,
              messageOrigin: params.messageOrigin,
              agentMessageOrigins: params.agentMessageOrigins,
              agentMessages: params.agentMessages,
            },
          }
        : undefined;
    if (retryableCodexTurnStart) {
      this.context.turnState.assignRetry(
        params.threadId,
        retryableCodexTurnStart,
      );
    }
    const startingOrigin = this.beginStartingTurnOrigin({
      backend: params.backend,
      threadId: params.threadId,
      origin: resolveThreadMessageOrigin(params),
      turnInputSource: resolveTurnInputSource(params),
    });
    const submitted = await this.threadStarts.submitCodex({
      identity: params,
      pendingTurnId: syntheticStartedTurnId,
      submit: async () => await this.withCodexThreadClient(
        params.threadId,
        async (client, mode) => {
          if (this.closed) {
            throw new Error("Desktop backend registry closed before turn start");
          }
          const effectiveMode = params.executionMode ?? mode;
          const modeSettings = executionModeSettings(effectiveMode);
          const tokenMiserConfig =
            await this.buildSupportedCodexTokenMiserConfig({
              client,
              enabled: tokenMiserEnabledForThread,
            });
          const dynamicTools =
            await this.buildSupportedCodexDynamicToolsRefresh({
              client,
              threadId: params.threadId,
              tokenMiserEnabled: tokenMiserEnabledForThread,
            });
          const pwrdrvrTokenMiser =
            await this.buildSupportedPwrdrvrTokenMiserActivation({
              client,
              enabled: tokenMiserEnabledForThread,
            });
          const supportedCodexThreadConfig = mergeCodexThreadConfigs(
            codexThreadConfig,
            tokenMiserConfig,
          );
          const agentMemoryContext = await this.readAgentMemoryContext(params);
          const started = await listingDiagnostics.trace("workflow", { query: "provider-turn-start" }, () => client.startTurn({
            threadId: params.threadId,
            ...delegatedTurnAttribution(params.messageOrigin,
              params.agentMessages?.map((message) => message.origin) ?? params.agentMessageOrigins),
            input,
            agentMemoryContext,
            ...(pendingMessageContextId ? {
              onInputTextPrepared: (text: string | undefined) => {
                this.updatePendingThreadMessageText(pendingMessageContextId, text);
              },
            } : {}),
            ...(cwd ? { cwd } : {}),
            collaborationMode: params.collaborationMode,
            ...turnParams,
            approvalPolicy: params.approvalPolicy ?? modeSettings.approvalPolicy,
            approvalsReviewer: modeSettings.approvalsReviewer,
            sandbox: ownerSandboxForMode(getOwnerHostServices().runtimePolicy, effectiveMode, params.sandbox, modeSettings.sandbox),
            ...(overlay?.codexEnvironmentRuntime
              ? { codexEnvironmentRuntime: overlay.codexEnvironmentRuntime }
              : {}),
            ...(supportedCodexThreadConfig
              ? { config: supportedCodexThreadConfig }
              : {}),
            defaultModeRequestUserInput:
              this.resolveCodexDefaultModeRequestUserInputFn(),
            ...(dynamicTools !== undefined ? { dynamicTools } : {}),
            ...(pwrdrvrTokenMiser !== undefined
              ? { pwrdrvrTokenMiser }
              : {}),
          }));
          activeTurnMode = effectiveMode;
          return started;
        },
        params.executionMode,
      ),
      activeTurns: () => [...this.context.turnState.registeredTurnKeys()].flatMap((key) => {
        const active = parseActiveTurnKey(key);
        return active ? [active] : [];
      }),
      fail: async (error) => {
        this.dropStartingTurnOrigin(startingOrigin);
        await this.emit(buildTurnStartFailureEvent(params, syntheticStartedTurnId, error), codexStartObservation?.sequence);
      },
      retireFailed: () => {
        this.retireCodexTurnStart(params, syntheticStartedTurnId, startReservation, codexStartObservation);
        this.forgetPendingThreadMessageContext(pendingMessageContextId);
      },
      discardRetry: () => {
        if (retryableCodexTurnStart && this.context.turnState.ownsRetry(params.threadId, retryableCodexTurnStart)) {
          this.context.turnState.forgetRetry(params.threadId);
        }
        if (retryableCodexTurnStart) this.context.turnState.releaseRetryReceipt(retryableCodexTurnStart);
      },
      recovery: retryableCodexTurnStart && this.codexClient.recoverInvalidPersistedResponseMessageIds ? {
        accepts: isCodexInvalidResponseMessageIdError,
        run: async (failureMessage) => {
          const recovery = await this.codexRuntimeSupervisor.queueCodexInvalidIdRecovery(
            this.context.turnState.retryReceipt(retryableCodexTurnStart),
            failureMessage,
          );
          this.codexRuntimeSupervisor.maybeDrainCodexInvalidIdRecoveries();
          return await recovery.completion;
        },
        failed: (details) => this.codexRuntimeSupervisor.emitCodexInvalidIdRecoveryUpdate(details),
      } : undefined,
    });
    if (submitted.kind === "recovered") return submitted.response;
    const result = submitted.turn;
    const retryTerminalObserved = () => retryableCodexTurnStart
      ? this.context.turnState.retryReceipt(retryableCodexTurnStart).terminalObserved ?? false : false;
    return await this.threadStarts.finalizeCodex({
      identity: params, turn: result, settings: turnParams, executionMode: params.executionMode,
      bindOrigin: () => this.bindStartingTurnOrigin(startingOrigin, result, retryTerminalObserved()),
      bindRetry: () => { if (retryableCodexTurnStart) this.context.turnState.updateRetry(retryableCodexTurnStart, { turnId: result.turnId }); },
      bindPdf: () => this.pdfAttachmentStore.bindTurn(
        { backend: params.backend, threadId: result.threadId, turnId: result.turnId }, pdfAttachments,
      ),
      bindContext: () => this.bindPendingThreadMessageContext(pendingMessageContextId, result.turnId),
      persistOrigin: () => this.persistStartingTurnOrigin(startingOrigin),
      disposeOrigin: () => this.dropStartingTurnOrigin(startingOrigin),
      handoff: {
        identity: params, pendingTurnId: syntheticStartedTurnId, turn: result,
        get terminalObserved() { return retryTerminalObserved(); },
        executionMode: activeTurnMode, reserved: reserveCodexStart,
        bindReview: () => this.managedReviewService.rebindPendingReviewStartsForStartedTurn({
          backend: params.backend, threadId: params.threadId,
          pendingTurnId: syntheticStartedTurnId, turnId: result.turnId,
        }),
        activateCollaboration: () => this.context.turnState.setCollaboration(
          { backend: "codex", threadId: result.threadId, turnId: result.turnId }, params.collaborationMode?.mode ?? "default",
        ),
        retirePending: () => {
          this.context.turnState.forgetExecution({ threadId: params.threadId, turnId: syntheticStartedTurnId });
          this.context.turnState.unregisterTurn({ backend: params.backend, threadId: params.threadId, turnId: syntheticStartedTurnId });
        },
        activateExecutionMode: (mode) => this.context.turnState.acceptExecution({ threadId: result.threadId, turnId: result.turnId }, mode),
        release: () => {
          this.context.turnState.releaseStart(params.threadId, startReservation);
          if (retryableCodexTurnStart) this.context.turnState.releaseRetryReceipt(retryableCodexTurnStart);
          this.codexRuntimeSupervisor.maybeDrainCodexInvalidIdRecoveries();
        },
      },
      persistModel: () => this.overlayStore.setThreadModelSettings({
        backend: params.backend,
        threadId: result.threadId,
        ...turnParams,
      }),
      persistExecutionMode: () => this.overlayStore.setThreadExecutionMode({
        backend: params.backend,
        threadId: result.threadId,
        executionMode: params.executionMode!,
      }),
      retainAttachments: () => this.rememberTurnInputAttachments({
        backend: params.backend,
        threadId: result.threadId,
        turnId: result.turnId,
        input,
      }),
      scheduleReplay: () => this.scheduleCompletedTurnFromReplay({
        backend: params.backend, threadId: result.threadId, turnId: result.turnId,
      }),
      forgetTitleInput: () => this.threadTitles.forgetPendingInput(params),
      scheduleTitle: () => this.scheduleThreadTitleGeneration({ backend: params.backend, threadId: result.threadId, input }),
      failed: (stage, error) => backendRegistryLog.warn("accepted_turn_finalization_failed", {
        backend: params.backend, threadId: result.threadId, turnId: result.turnId, stage,
        error: error instanceof Error ? error.message : String(error),
      }),
    });
  }

  private retireCodexTurnStart(params: { backend: AppServerBackendKind; threadId: string }, pendingTurnId: string, reserved: object | undefined,
    observation?: { sequence: number; previous?: { sequence: number; status: AppServerThreadStatus } },
  ): void {
    this.context.turnState.forgetCollaboration({ backend: params.backend, threadId: params.threadId, turnId: pendingTurnId });
    this.context.turnState.forgetExecution({ threadId: params.threadId, turnId: pendingTurnId });
    this.context.turnState.unregisterTurn({ backend: params.backend, threadId: params.threadId, turnId: pendingTurnId });
    if (reserved) this.context.turnState.releaseStart(params.threadId, reserved);
    // A list read during terminal delivery can project the still-reserved
    // start as active. Once released, restore the latest status observation;
    // a newer provider status or another real turn retains its authority.
    if (reserved && observation && this.context.turnState.statusObservation(params.threadId)?.sequence === observation.sequence) {
      // Restore only the observation owned by this synthetic start. Genuine
      // status/turn events have a newer sequence and remain authoritative.
      this.context.turnState.restoreObservation(params.threadId, observation.sequence, observation.previous);
    }
    const observedStatus = this.context.turnState.statusObservation(params.threadId)?.status;
    if (reserved && observedStatus) this.seedBackendCodexThreadStatus(params.threadId, observedStatus);
    this.threadTitles.forgetPendingInput(params);
  }

  private async registerPendingThreadMessageContext(params: {
    backend: AppServerBackendKind;
    input?: AppServerTurnInputItem[];
    threadId: string;
    origin?: AppServerThreadMessageOrigin;
    text?: string;
    turnId?: string;
    retainAttachments?: boolean;
  }): Promise<string | undefined> {
    const admittedCodexTurnSequence = params.backend === "codex" && !params.turnId
      ? this.codexMessageContextTurnSequence
      : undefined;
    const imageParts = await pendingThreadMessageImageParts(params.input, params);
    const retainedInput = params.retainAttachments
      ? await stageTurnInputAttachmentsForRetention(
          params.input ?? [],
          { privateStorageRoots: this.localFilePrivateStorageRoots, owner: params },
        )
      : [];
    if (
      !params.origin
      && imageParts.length === 0
      && retainedInput.length === 0
    ) {
      return undefined;
    }
    // Codex can defer a steer behind a long-running tool for more than ten
    // minutes. Keep its origin until the item completes;
    // another thread's activity must not expire an accepted message's sender.
    const id = randomUUID();
    this.pendingThreadMessageContexts.set(id, {
      backend: params.backend,
      createdAt: Date.now(),
      ...(admittedCodexTurnSequence !== undefined ? { admittedCodexTurnSequence } : {}),
      id,
      ...(imageParts.length > 0 ? { imageParts } : {}),
      ...(retainedInput.length > 0 ? { retainedInput } : {}),
      ...(params.origin ? { origin: params.origin } : {}),
      ...(params.text ? { text: params.text } : {}),
      threadId: params.threadId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
    });
    return id;
  }

  private updatePendingThreadMessageText(id: string, text: string | undefined): void {
    const pending = this.pendingThreadMessageContexts.get(id);
    if (pending) {
      pending.text = text;
    }
  }

  private bindPendingThreadMessageContext(
    id: string | undefined,
    turnId: string,
  ): void {
    if (!id) {
      return;
    }
    const pending = this.pendingThreadMessageContexts.get(id);
    if (pending) {
      pending.turnId = turnId;
      this.mergeTurnInputAttachments({
        backend: pending.backend,
        threadId: pending.threadId,
        turnId,
        input: pending.retainedInput ?? [],
      });
    }
  }

  private forgetPendingThreadMessageContext(id: string | undefined): void {
    if (id) {
      this.pendingThreadMessageContexts.delete(id);
    }
  }

  private findPendingThreadMessageContext(params: {
    backend: AppServerBackendKind;
    threadId: string;
    messageId?: string;
    text?: string;
    turnId?: string;
  }): PendingThreadMessageContext | undefined {
    const observedCodexTurnSequence = params.backend === "codex" && params.turnId
      ? this.codexMessageContextTurnObservations.get(params.threadId)?.get(params.turnId)
      : undefined;
    const candidates = [...this.pendingThreadMessageContexts.values()]
      .filter(
        (pending) =>
          pending.backend === params.backend
          && pending.threadId === params.threadId
          && (!pending.messageId || pending.messageId === params.messageId)
          // After turn-end, text alone cannot distinguish a delayed item
          // from a later manual message. Require its turn or bound item id.
          && (
            !pending.turnEnded
            || Boolean(params.turnId)
            || Boolean(pending.messageId && pending.messageId === params.messageId)
          )
          && (
            !pending.turnId
            || !params.turnId
            || pending.turnId === params.turnId
          )
          // An unbound start may receive its real user item before the start
          // response. Identical text from a previously observed turn cannot
          // claim that context while the new provider identity is unknown.
          && (
            pending.turnId
            || pending.admittedCodexTurnSequence === undefined
            || observedCodexTurnSequence === undefined
            || observedCodexTurnSequence > pending.admittedCodexTurnSequence
          ),
      )
      .sort((left, right) => left.createdAt - right.createdAt);
    if (params.messageId) {
      // A started item owns its context until completion. A steer in the same
      // turn must never consume that context, even when its text is identical.
      const bound = candidates.find((pending) => pending.messageId === params.messageId);
      if (bound) {
        return bound;
      }
      // Turn identity alone is not message identity. Codex can deliver several
      // user items in a turn, including operator steers with no pending origin.
      return candidates.find((pending) => pending.text?.trim() === params.text?.trim());
    }
    return (
      candidates.find(
        (pending) => pending.turnId && pending.turnId === params.turnId,
      )
      ?? candidates.find((pending) => !pending.turnId)
    );
  }

  private async withThreadMessageContext(event: AgentEvent): Promise<AgentEvent> {
    if (event.notification.method === "turn/started") {
      const notification = event.notification as {
        method: "turn/started";
        params: {
          threadId: string;
          turnId?: string;
          turn: { id: string };
        };
      };
      const turnId = notification.params.turnId ?? notification.params.turn.id;
      // An optimistic start owns admission, not a provider turn. Context is
      // staged before it now, and must stay unbound for provider user items
      // that can arrive before the start response or provider turn/started.
      if (event.backend === "codex" && isPendingTurnId(notification.params.threadId, turnId)) {
        return event;
      }
      const pending = this.findPendingThreadMessageContext({
        backend: event.backend,
        threadId: notification.params.threadId,
        turnId,
      });
      if (pending && !pending.turnId) {
        pending.turnId = turnId;
        this.mergeTurnInputAttachments({
          backend: pending.backend,
          threadId: pending.threadId,
          turnId,
          input: pending.retainedInput ?? [],
        });
      }
      return event;
    }
    if (
      event.notification.method !== "item/started"
      && event.notification.method !== "item/completed"
    ) {
      return event;
    }
    const notification = event.notification as {
      method: "item/started" | "item/completed";
      params: {
        threadId: string;
        turnId?: string;
        item: {
          content?: unknown;
          id: string;
          type: string;
          origin?: AppServerThreadMessageOrigin;
          text?: string;
        };
      };
    };
    if (notification.params.item.type !== "userMessage") {
      return event;
    }
    const content = Array.isArray(notification.params.item.content)
      ? notification.params.item.content
      : [];
    const text = notification.params.item.text
      ?? extractFirstMeaningfulTextInput(content.filter(
        (part): part is Extract<AppServerTurnInputItem, { type: "text" }> =>
          Boolean(part)
          && typeof part === "object"
          && part.type === "text"
          && typeof part.text === "string",
      ));
    const pending = this.findPendingThreadMessageContext({
      backend: event.backend,
      threadId: notification.params.threadId,
      messageId: notification.params.item.id,
      text,
      turnId: notification.params.turnId,
    });
    if (!pending) {
      return event;
    }
    pending.messageId = notification.params.item.id;
    await this.persistThreadMessageOrigin({
      backend: event.backend,
      threadId: notification.params.threadId,
      messageId: notification.params.item.id,
      origin: pending.origin,
    });
    if (event.notification.method === "item/completed") {
      this.pendingThreadMessageContexts.delete(pending.id);
    }
    const imageParts =
      pending.imageParts?.length && !contentHasRenderableImage(content)
        ? pending.imageParts
        : [];
    return {
      ...event,
      notification: {
        ...notification,
        params: {
          ...notification.params,
          item: {
            ...notification.params.item,
            ...(imageParts.length > 0
              ? { content: [...content, ...imageParts] }
              : {}),
            ...(pending.origin ? { origin: pending.origin } : {}),
          },
        },
      } as AppServerNotification,
    };
  }

  private async persistThreadMessageOrigin(params: {
    backend: AppServerBackendKind;
    threadId: string;
    messageId: string;
    origin?: AppServerThreadMessageOrigin;
  }): Promise<void> {
    if (
      !params.origin
      || typeof this.overlayStore.upsertThreadMessageOrigin !== "function"
    ) {
      return;
    }
    try {
      await this.overlayStore.upsertThreadMessageOrigin({
        backend: params.backend,
        threadId: params.threadId,
        messageId: params.messageId,
        origin: params.origin,
      });
    } catch (error) {
      backendRegistryLog.warn("failed to persist injected message origin", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
        messageId: params.messageId,
        threadId: params.threadId,
      });
    }
  }

  private scheduleCompletedTurnFromReplay(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): void {
    setTimeout(() => {
      void withCodexRequestActivity({ countsAsActivity: false }, () =>
        this.emitCompletedTurnFromReplay(params)).catch((error: unknown) => {
        backendRegistryLog.warn("failed to emit completed turn replay event", {
          backend: params.backend,
          threadId: params.threadId,
          turnId: params.turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 0);
  }

  private async emitCompletedTurnFromReplay(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): Promise<void> {
    let output: Array<{ type: "text"; text: string }> = [];
    try {
      const replay = await this.readThread({
        backend: params.backend,
        threadId: params.threadId,
      });
      output = assistantOutputForTurn(replay.replay, params.turnId);
    } catch (error) {
      backendRegistryLog.warn("failed to read completed turn replay for local event", {
        backend: params.backend,
        threadId: params.threadId,
        turnId: params.turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (output.length === 0) {
      return;
    }

    await this.emit({
      backend: params.backend,
      notification: {
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          turn: {
            id: params.turnId,
            status: "completed",
            completedAt: Date.now(),
            output,
          },
        },
      },
    });
  }

  // Review members the registry's importers use. ManagedReviewService owns
  // the state; each member delegates to it.
  prepareReviewRequest(
    params: StartReviewRequest,
    trustedSnapshot = false,
  ): Promise<StartReviewRequest> {
    return this.managedReviewService.prepareReviewRequest(params, trustedSnapshot);
  }

  startReview(
    params: StartReviewRequest,
    trustedSnapshot = false,
    turnAttribution?: ReturnType<typeof delegatedTurnAttribution>,
  ): Promise<StartReviewResponse> {
    if (this.codexOpenAiProviderEnabled) return this.managedReviewService.startReview(params, trustedSnapshot, turnAttribution);
    return this.assertThreadCodexInferenceAvailable(params)
      .then(() => this.managedReviewService.startReview(params, trustedSnapshot, turnAttribution));
  }

  submitReview(
    params: StartReviewRequest & {
      idempotencyKey?: string;
    },
    trustedSnapshot = false,
  ): Promise<
    | {
        status: "started";
        response: StartReviewResponse;
      }
    | {
        status: "scheduled";
        pendingReviewId: string;
        invokingTurnId: string;
      }
  > {
    return this.managedReviewService.submitReview(params, trustedSnapshot);
  }

  cancelPendingReview(
    pendingReviewId: string,
    reason: string,
  ): boolean {
    return this.managedReviewService.cancelPendingReview(pendingReviewId, reason);
  }

  async controlActiveTurn(
    request: ControlActiveTurnRequest,
  ): Promise<ControlActiveTurnResponse> {
    // A peer's agent steering a thread here meets the same project pause a
    // local agent does. Stopping starts nothing, so it passes.
    const projectRefusal = request.operation === "steer" && request.messageOrigin?.kind === "agent"
      ? this.projectPausedThreadMessageRefusal(request)
      : undefined;
    if (projectRefusal) {
      return {
        ok: false,
        backend: request.backend,
        threadId: request.threadId,
        requestId: request.requestId,
        error: { code: PROJECT_PAUSED_ERROR_CODE, message: projectRefusal },
      };
    }
    const requestKey = [
      request.backend,
      request.threadId,
      request.requestId,
    ].join("\u0000");
    const signature = createHash("sha256")
      .update(JSON.stringify({
        expectedTurnId: request.expectedTurnId ?? null,
        input: request.input ?? [],
        messageOrigin: withoutTurnAttribution(request.messageOrigin) ?? null,
        operation: request.operation,
      }))
      .digest("hex");
    const accepted = this.acceptedActiveTurnControlRequests.get(requestKey);
    if (accepted) {
      if (accepted.signature !== signature) {
        return {
          ok: false,
          backend: request.backend,
          threadId: request.threadId,
          requestId: request.requestId,
          error: {
            code: "invalid_arguments",
            message:
              `Turn control request id ${request.requestId} was reused with different arguments.`,
          },
        };
      }
      const response = await accepted.promise;
      return response.ok
        ? { ...response, idempotentReplay: true }
        : response;
    }

    const promise = this.submitActiveTurnControl(request);
    if (
      this.acceptedActiveTurnControlRequests.size
      >= MAX_ACCEPTED_THREAD_CONTROL_REQUESTS
    ) {
      const oldestKey =
        this.acceptedActiveTurnControlRequests.keys().next().value;
      if (oldestKey) {
        this.acceptedActiveTurnControlRequests.delete(oldestKey);
      }
    }
    this.acceptedActiveTurnControlRequests.set(requestKey, {
      promise,
      signature,
    });
    try {
      const response = await promise;
      if (
        !response.ok
        && this.acceptedActiveTurnControlRequests.get(requestKey)?.promise
          === promise
      ) {
        this.acceptedActiveTurnControlRequests.delete(requestKey);
      }
      return response;
    } catch (error) {
      if (
        this.acceptedActiveTurnControlRequests.get(requestKey)?.promise
        === promise
      ) {
        this.acceptedActiveTurnControlRequests.delete(requestKey);
      }
      throw error;
    }
  }

  private async submitActiveTurnControl(
    request: ControlActiveTurnRequest,
  ): Promise<ControlActiveTurnResponse> {
    const failure = (
      code: ControlActiveTurnErrorCode,
      message: string,
      details: { activeTurnId?: string; expectedTurnId?: string } = {},
    ): ControlActiveTurnResponse => ({
      ok: false,
      backend: request.backend,
      threadId: request.threadId,
      requestId: request.requestId,
      error: { code, message, ...details },
    });
    const lockKey = executionModeQueueKey(request.backend, request.threadId);
    const perform = async (): Promise<ControlActiveTurnResponse> => {
      const backend = (
        await this.listBackends({ includeUnavailable: true })
      ).backends.find((candidate) => candidate.kind === request.backend);
      if (!backend?.available) {
        return failure(
          "unsupported_backend",
          `Backend ${request.backend} is not available on this instance.`,
        );
      }
      const capability = request.operation === "stop"
        ? "interruptTurn"
        : "steerTurn";
      if (!backend.capabilities[capability]) {
        return failure(
          "unsupported_capability",
          `Backend ${request.backend} does not support ${request.operation === "stop" ? "turn interruption" : "turn steering"}.`,
        );
      }
      if (request.operation === "steer" && !(request.input?.length)) {
        return failure(
          "invalid_arguments",
          "Steering an active turn requires non-empty input.",
        );
      }

      const active = this.getActiveTurnForThread({
        backend: request.backend,
        threadId: request.threadId,
      });
      if (!active) {
        return failure(
          "no_active_turn",
          `Thread ${request.threadId} has no active turn.`,
        );
      }
      if (
        request.expectedTurnId
        && request.expectedTurnId !== active.turnId
      ) {
        return failure(
          "stale_target",
          `Thread ${request.threadId} now has active turn ${active.turnId}, not expected turn ${request.expectedTurnId}.`,
          {
            activeTurnId: active.turnId,
            expectedTurnId: request.expectedTurnId,
          },
        );
      }

      try {
        if (request.operation === "stop") {
          const managedAcpReview = isAcpBackendId(request.backend)
            ? this.managedReviewService.findReviewForParentTurn({
                backend: request.backend,
                parentThreadId: request.threadId,
                turnId: active.turnId,
              })
            : undefined;
          const stopped = isAcpBackendId(request.backend) && !managedAcpReview
            ? await this.acpSessionPromptLocks.run(
                lockKey,
                async () => await this.interruptAcpTurn(active, true),
              )
            : await this.interruptTurn(active);
          return {
            ok: true,
            backend: stopped.backend,
            threadId: stopped.threadId,
            requestId: request.requestId,
            turnId: stopped.turnId,
            disposition: "interrupted",
          };
        }
        if (request.messageOrigin?.kind === "agent") {
          const queued = await this.admitThreadAttachments({ ...request, input: request.input ?? [] }, (input, onAdmission) => this.threadTurnQueue.submitSteer({
            backend: request.backend,
            threadId: request.threadId,
            input,
            messageOrigin: request.messageOrigin,
            origin: "manual",
          }, { deferStart: true, onAdmission }));
          return {
            ok: true,
            backend: request.backend,
            threadId: request.threadId,
            requestId: request.requestId,
            turnId: queued.entry.id,
            disposition: "queued",
          };
        }
        const steered = await this.steerTurn(
          {
            backend: request.backend,
            threadId: request.threadId,
            expectedTurnId: active.turnId,
            requestId: request.requestId,
            input: request.input ?? [],
          },
          request.messageOrigin,
        );
        if (steered.disposition === "scheduled") {
          return failure(
            "stale_target",
            "The active turn changed before steering; no queued fallback was created.",
            {
              expectedTurnId: active.turnId,
            },
          );
        }
        return {
          ok: true,
          backend: steered.backend,
          threadId: steered.threadId,
          requestId: request.requestId,
          turnId: steered.turnId,
          disposition:
            steered.disposition === "queued" ? "queued" : "steered",
        };
      } catch (error) {
        if (error instanceof ActiveTurnControlPreconditionError) {
          return failure(error.code, error.message, {
            ...(error.activeTurnId
              ? { activeTurnId: error.activeTurnId }
              : {}),
            ...(request.expectedTurnId
              ? { expectedTurnId: request.expectedTurnId }
              : {}),
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        if (isThreadLockRefusal(message)) {
          return failure("forbidden", message);
        }
        if (/unsupported|does not support/i.test(message)) {
          return failure("unsupported_capability", message);
        }
        if (/no active turn/i.test(message)) {
          return failure("no_active_turn", message);
        }
        if (/active|expected turn|stale|in progress/i.test(message)) {
          return failure("stale_target", message, {
            expectedTurnId: active.turnId,
          });
        }
        throw error;
      }
    };

    return await this.activeTurnControlLocks.run(lockKey, perform);
  }

  private async interruptAcpTurn(
    params: {
      backend: AppServerBackendKind;
      threadId: string;
      turnId: string;
    },
    validateActiveTurn = false,
  ): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    if (!isAcpBackendId(params.backend)) {
      throw new Error(`Backend ${params.backend} is not an ACP backend.`);
    }
    const client = await this.acpBackend.getClientForSession(
      params.backend,
      params.threadId,
    );
    if (validateActiveTurn) {
      const active = this.getActiveTurnForThread(params);
      if (!active) {
        throw new ActiveTurnControlPreconditionError(
          "no_active_turn",
          `Thread ${params.threadId} has no active turn.`,
        );
      }
      if (active.turnId !== params.turnId) {
        throw new ActiveTurnControlPreconditionError(
          "stale_target",
          `Thread ${params.threadId} now has active turn ${active.turnId}, not expected turn ${params.turnId}.`,
          active.turnId,
        );
      }
    }
    // Invoke cancel without an intervening await after the final active-turn
    // check. The shared ACP prompt lock prevents the next queued prompt from
    // starting until this cancellation request has been delivered.
    const cancellation = client.cancelSession(params.threadId);
    await cancellation;
    await this.emit({
      backend: params.backend,
      notification: {
        method: "turn/cancelled",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          turn: {
            id: params.turnId,
            status: "cancelled",
            completedAt: Date.now(),
          },
        },
      },
    });
    return params;
  }

  private assertExpectedAcpSteerTurn(params: {
    backend: AcpBackendId;
    threadId: string;
    expectedTurnId: string;
  }): void {
    const active = this.getActiveTurnForThread(params);
    if (!active) {
      throw new Error(`Thread ${params.threadId} has no active turn to steer`);
    }
    if (active.turnId !== params.expectedTurnId) {
      throw new Error(
        `expected active turn id \`${params.expectedTurnId}\` but found \`${active.turnId}\``,
      );
    }
  }

  private assertIdleAcpThreadMutation(params: {
    action: string;
    backend: AcpBackendId;
    threadId: string;
  }): void {
    const active = this.getActiveTurnForThread(params);
    if (active) {
      throw new Error(
        `Wait for active turn ${active.turnId} to finish before ${params.action}`,
      );
    }
  }

  async interruptTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    // Revoke recovery synchronously, before interruption can yield. Keep this
    // turn's revocation even if the provider's cancellation acknowledgement is lost.
    this.compactionRecoveryStops.set(buildThreadIdentityKey(params.backend, params.threadId), params.turnId);
    return await this.threadInterruption.interruptTurn(params);
  }

  private readonly compactionRecoveryStops = new Map<string, string>();
  private readonly compactionRecoveryAdmissions = new Map<string, { allowed: () => boolean; admit: () => boolean }>();

  /** Never queue, start a turn, or steer an assignment that replaced the compacted turn. */
  async steerCompactionRecovery(params: SteerTurnRequest, origin: AppServerThreadMessageOrigin, canSubmit: () => boolean,
    admit: () => boolean = canSubmit): Promise<{
    status: "steered" | "busy" | "discarded"; turnId?: string;
  }> {
    if (params.backend !== "codex") return { status: "discarded" };
    const allowed = () => canSubmit() && !this.isRestartGateClosed()
      && this.compactionRecoveryStops.get(buildThreadIdentityKey(params.backend, params.threadId)) !== params.expectedTurnId
      && this.getActiveTurnForThread(params)?.turnId === params.expectedTurnId;
    if (!allowed()) return { status: "discarded" };
    if (await this.isThreadLocked(params)) return { status: "busy" };
    this.compactionRecoveryAdmissions.set(params.requestId, { allowed, admit });
    try {
      const result = await this.steerTurn(params, origin);
      return { status: "steered", turnId: result.turnId };
    } catch (error) {
      if (error instanceof CompactionRecoveryRevoked) return { status: error.status };
      throw error;
    } finally {
      this.compactionRecoveryAdmissions.delete(params.requestId);
    }
  }

  private readonly threadInterruption = new ThreadInterruptionLifecycle({
    cancelTools: (target) => { this.mcpGatewayTools?.cancel(target.backend, target.threadId, target.turnId); },
    findReview: (target) => {
      const review = this.managedReviewService.findReviewForParentTurn({
        backend: target.backend, parentThreadId: target.threadId, turnId: target.turnId,
      });
      return review ? { backend: review.backend, threadId: review.reviewThreadId, turnId: review.turnId } : undefined;
    },
    readCodexInterruptTurnId: (target) => this.context.turnState.reviewInterrupt(
      { threadId: target.threadId, turnId: target.turnId },
    ),
    interruptClaude: async (target) => await this.claudeBackend.interruptTurn(target),
    interruptAcp: async (target, serializePrompt) => serializePrompt
      ? await this.acpSessionPromptLocks.run(executionModeQueueKey(target.backend, target.threadId),
          async () => await this.interruptAcpTurn(target))
      : await this.interruptAcpTurn(target),
    interruptCodex: async (target, routing) => {
      const requestedKey = buildActiveTurnModeKey(target.threadId, routing.requestedTurnId);
      const activeMode = routing.review
        ? this.context.turnState.executionMode(requestedKey)
        : this.context.turnState.executionMode({ threadId: target.threadId, turnId: target.turnId })
          ?? this.context.turnState.executionMode(requestedKey);
      if (routing.review) {
        const client = activeMode ? this.getClient("codex", activeMode) : this.codexClient;
        return await client.interruptTurn({ threadId: target.threadId, turnId: target.turnId });
      }
      return activeMode
        ? await this.getClient("codex", activeMode).interruptTurn(target)
        : await this.withCodexThreadClient(target.threadId, async (client) => await client.interruptTurn(target));
    },
    retireCodexTurn: (requested, result) => {
      const requestedKey = buildActiveTurnModeKey(requested.threadId, requested.turnId);
      const activeKey = buildActiveTurnModeKey(result.threadId, result.turnId);
      this.context.turnState.forgetExecution(activeKey);
      this.context.turnState.forgetReview(activeKey);
      if (requestedKey !== activeKey) {
        this.context.turnState.forgetExecution(requestedKey);
        this.context.turnState.forgetReview(requestedKey);
      }
    },
    reviewInterrupted: (parent, review) => {
      backendRegistryLog.info(isAcpBackendId(review.backend)
        ? "managed ACP review interrupt requested" : "review interrupt requested", {
        parentThreadId: parent.threadId,
        reviewThreadId: review.threadId,
        turnId: review.turnId,
      });
    },
  });

  /**
   * Turns a backend scheduled in its own live process, from memory. Only
   * Claude schedules them: its /loop wake-ups and session crons.
   */
  listBackendWakes(params: { backend: AppServerBackendKind; threadId: string }): AppServerBackendWake[] {
    return params.backend === "claude" ? this.claudeBackend.listSessionWakes(params.threadId) : [];
  }

  listPendingTaskMonitorWakes(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Array<{
    monitorId: string;
    task: string;
    backend: AppServerBackendKind;
    monitorThreadId?: string;
    model?: string;
    createdAt: number;
    lastActivityAt: number;
    pollIntervalSeconds: number;
    wakeSuppressed?: true;
  }> {
    return this.subAgentMonitorService.listPendingTaskMonitorWakes(params);
  }

  taskMonitorWakesTripped(thread: { backend: AppServerBackendKind; threadId: string }): boolean {
    return this.subAgentMonitorService.taskMonitorWakesTripped(thread);
  }

  listTaskMonitorWakeAlerts() {
    return this.subAgentMonitorService.listTaskMonitorWakeAlerts();
  }

  acknowledgeTaskMonitorWakeAlert(thread: { backend: AppServerBackendKind; threadId: string }, generation: number): boolean {
    return this.subAgentMonitorService.acknowledgeTaskMonitorWakeAlert(thread, generation);
  }

  rearmTaskMonitorWakes(thread: { backend: AppServerBackendKind; threadId: string }, generation?: number): boolean {
    if (!this.subAgentMonitorService.rearmTaskMonitorWakes(thread, generation)) return false;
    for (const entry of this.threadTurnQueue.getQueuedEntries(thread)) {
      if (isOnlyTaskMonitorWake(entry)) {
        this.cancelQueuedTurn(entry.id, "Job Monitor wakes were rearmed for future monitors.");
      }
    }
    return true;
  }

  async dismissFailedSubAgents(params: DismissFailedSubAgentsRequest): Promise<DismissFailedSubAgentsResponse> {
    if (!params || typeof params.backend !== "string" || !isAppServerBackendKind(params.backend)
      || typeof params.threadId !== "string" || !params.threadId.trim()
      || !Array.isArray(params.attempts) || !params.attempts.every((attempt) =>
        attempt && typeof attempt.monitorId === "string" && attempt.monitorId.length > 0
        && typeof attempt.attemptId === "string" && attempt.attemptId.length > 0)) {
      throw new Error("Invalid failed sub-agent dismissal request.");
    }
    const dismissedCount = await this.overlayStore.dismissFailedThreadSubAgents(params);
    if (dismissedCount > 0) {
      await this.emit({
        backend: params.backend,
        notification: { method: "thread/subAgentFailures/dismissed", params: { threadId: params.threadId } },
      });
    }
    return { dismissedCount };
  }

  stopSubAgent(params: StopSubAgentRequest): Promise<StopSubAgentResponse> {
    return this.subAgentMonitorService.stopSubAgent(params);
  }

  async compactThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<{
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
    itemId?: string;
  }> {
    if (isAcpBackendId(params.backend)) {
      throw new Error(
        "ACP backend " + params.backend + " does not support thread compaction",
      );
    }
    await this.codexRuntimeSupervisor.invalidIdRecoveryBarrier;
    return await this.compactThreadNow({ backend: "codex", threadId: params.threadId });
  }

  private async compactThreadNow(params: {
    backend: "codex";
    threadId: string;
    invalidIdRecoveryAttempted?: boolean;
  }): Promise<{
    backend: "codex";
    threadId: string;
    turnId: string;
    itemId?: string;
  }> {
    if (this.closed) throw new Error("Desktop backend registry is closed");
    await this.assertThreadCodexInferenceAvailable(params);
    // Compaction runs a backend turn, so a lock refuses it like any other.
    await this.assertThreadNotLocked(params.backend, params.threadId);
    await this.threadArchiveCoordinator.ensureCheckoutAwake(params);
    if (
      this.context.turnState.hasStartReservation(params.threadId)
      || this.threadHasActiveTurn(params.threadId, "codex")
      || this.context.turnState.hasRetry(params.threadId)
    ) {
      throw new Error("Cannot compact a thread while another operation is running");
    }
    const candidate: CodexRetryableCompaction = {
      kind: "compact",
      params: { backend: "codex", threadId: params.threadId },
      invalidIdRecoveryAttempted: params.invalidIdRecoveryAttempted,
      turnId: `pending:compact:${params.threadId}`,
    };
    // Notifications can arrive before the RPC response. Reserve the start so
    // recovery cannot stop the shared process while this request is in flight.
    const compactionReservation = this.context.turnState.reserveStart(params.threadId, "compact", candidate);
    this.context.turnState.assignRetry(params.threadId, candidate);
    try {
      const result = await this.withCodexThreadClient(params.threadId, async (client) => {
        if (!client.compactThread) {
          throw new Error("Selected backend does not support thread compaction");
        }
        const overlay = await this.overlayStore.getThreadOverlayState({
          backend: "codex", threadId: params.threadId,
        });
        const settings = await this.resolveModelSettings("codex", {
          ...(this.codexOpenAiProviderEnabled ? {} : {
            codexModelProviderId: this.codexClient.modelProviderForThread?.(params.threadId),
          }),
          model: overlay?.model,
          serviceTier: overlay?.serviceTier,
          reasoningEffort: overlay?.reasoningEffort,
          reasoningEffortsByModel: overlay?.reasoningEffortsByModel,
          fastMode: overlay?.fastMode,
        });
        return await client.compactThread({ threadId: params.threadId, ...settings });
      });
      // The adapter's compact:<threadId> is a placeholder. Prefer the real
      // turn ID captured from turn/started (or an early terminal notification).
      const receipt = this.context.turnState.retryReceipt(candidate);
      if (receipt.turnId?.startsWith("pending:") && !result.turnId.startsWith("compact:")) {
        this.context.turnState.updateRetry(candidate, { turnId: result.turnId });
      }
      const bound = this.context.turnState.retryReceipt(candidate);
      return {
        backend: "codex",
        ...result,
        turnId: bound.turnId?.startsWith("pending:") ? result.turnId : bound.turnId!,
      };
    } catch (error) {
      if (this.context.turnState.ownsRetry(params.threadId, candidate)) {
        this.context.turnState.forgetRetry(params.threadId);
      }
      throw error;
    } finally {
      this.context.turnState.releaseStart(params.threadId, compactionReservation);
      const terminalObserved = this.context.turnState.retryReceipt(candidate).terminalObserved;
      this.context.turnState.releaseRetryReceipt(candidate);
      if (terminalObserved) {
        // An early terminal could not dispatch while the RPC owned its start
        // reservation. Recheck after that last ownership boundary is released.
        this.threadTurnQueue.scheduleThreadDrain(params);
      }
      this.codexRuntimeSupervisor.maybeDrainCodexInvalidIdRecoveries();
    }
  }

  // MCP members the registry's importers use. ThreadMcpConnections owns the
  // state; each member delegates to it.
  listThreadMcpServers(
    params: ListThreadMcpServersRequest,
  ): Promise<ListThreadMcpServersResponse> {
    return this.threadMcpConnections.listThreadMcpServers(params);
  }

  reloadCodexMcpConfig(
    params: ReloadCodexMcpConfigRequest,
  ): Promise<ReloadCodexMcpConfigResponse> {
    return this.threadMcpConnections.reloadCodexMcpConfig(params);
  }

  listCodexMcpServers(
    params: ListCodexMcpServersRequest = {},
  ): Promise<ListCodexMcpServersResponse> {
    return this.threadMcpConnections.listCodexMcpServers(params);
  }

  reloadCodexMcpServers(
    params: ReloadCodexMcpServersRequest,
  ): Promise<ReloadCodexMcpServersResponse> {
    return this.threadMcpConnections.reloadCodexMcpServers(params);
  }

  startCodexMcpServerLogin(
    params: StartCodexMcpServerLoginRequest,
  ): Promise<StartCodexMcpServerLoginResponse> {
    return this.threadMcpConnections.startCodexMcpServerLogin(params);
  }

  removeCodexMcpServer(
    params: RemoveCodexMcpServerRequest,
  ): Promise<RemoveCodexMcpServerResponse> {
    return this.threadMcpConnections.removeCodexMcpServer(params);
  }

  async steerTurn(
    params: SteerTurnRequest,
    messageOrigin?: AppServerThreadMessageOrigin,
  ): Promise<SteerTurnResponse> {
    return await this.threadSteering.steerTurn(params, messageOrigin);
  }

  private readonly threadSteering = new ThreadSteeringLifecycle({
    submit: (params, origin) => this.submitSteerTurn(params, origin),
    complete: (params, result, origin) => this.completeSteerTurn(params, result, origin),
  });

  private async completeSteerTurn(
    params: SteerTurnRequest,
    result: SteerTurnResponse,
    messageOrigin?: AppServerThreadMessageOrigin,
  ): Promise<void> {
    // The owner is announcing its shutdown. It contributes no user request
    // to the active turn and must leave its existing authority intact.
    if (messageOrigin === QUIET_RESTART_STEER_ORIGIN) return;
    if (result.disposition === "steered" && messageOrigin) {
      const turn = { backend: params.backend, threadId: params.threadId, turnId: result.turnId };
      // Read-modify-write: overlapping steers must merge, not overwrite.
      await this.turnCausalContextLocks.run(`${turn.backend}:${turn.threadId}:${turn.turnId}`, async () => {
        const previous = await this.readTurnCausalMessagingOrigin(turn);
        if (isCausalMessagingContext(previous) || isCausalMessagingContext(messageOrigin)) {
          // `user:<turnId>` is also the first prompt's displayed origin, and
          // the steerer did not write that prompt. Keep routing in its own row.
          await this.persistThreadMessageOrigin({ backend: turn.backend, threadId: turn.threadId,
            messageId: buildTurnCausalMessagingContextId(turn.turnId),
            origin: { kind: messageOrigin.kind, ...mergeCausalMessagingContext([previous, messageOrigin]) } });
        }
      });
    }
  }

  /**
   * What a rewind to before one prompt would put back. Only Claude restores
   * files, so only Claude reads anything from its provider here.
   */
  async previewThreadRewind(
    request: PreviewThreadRewindRequest,
  ): Promise<PreviewThreadRewindResponse> {
    const preview = request.backend === "claude"
      ? await this.claudeBackend.previewRewind(request.threadId, request.target)
      : {};
    return {
      backend: request.backend,
      threadId: request.threadId,
      target: request.target,
      ...preview,
    };
  }

  async rewindThread(
    request: RewindThreadRequest,
  ): Promise<RewindThreadResponse> {
    if (request.mode !== "conversation" && request.backend !== "claude") {
      throw new Error("This provider cannot restore files when it rewinds a thread");
    }
    const rewindId = randomUUID();
    let result: {
      promptText?: string;
      restoredFileCount?: number;
      targetPromptIndex?: number;
      undoable?: boolean;
      updatedAt: number;
    };
    if (request.backend === "claude") {
      await this.assertThreadNotLocked("claude", request.threadId);
      try {
        result = await this.claudeBackend.rewindThread({
          threadId: request.threadId,
          target: request.target,
          mode: request.mode,
          rewindId,
        });
      } finally {
        // A reply sent during the rewind waited in the queue.
        this.threadTurnQueue.scheduleThreadDrain({ backend: "claude", threadId: request.threadId });
      }
    } else if (isAcpBackendId(request.backend)) {
      const backend = request.backend;
      result = await this.acpSessionPromptLocks.run(
        executionModeQueueKey(backend, request.threadId),
        async () => {
          this.assertIdleAcpThreadMutation({
            backend,
            threadId: request.threadId,
            action: "rewinding",
          });
          return await this.acpBackend.rewindSessionBeforeMessage({
            backend,
            sessionId: request.threadId,
            messageId: request.target.messageId,
          });
        },
      );
    } else if (request.backend === "codex") {
      result = await this.revertCodexThread({
        threadId: request.threadId,
        beforeTurnId: request.target.turnId,
      });
    } else {
      throw new Error("Rewind is not available for this provider");
    }
    try {
      await this.overlayStore.appendThreadRewind({
        backend: request.backend,
        threadId: request.threadId,
        rewind: {
          id: rewindId,
          occurredAt: result.updatedAt,
          ...(request.removedTurnCount !== undefined
            ? { removedTurnCount: request.removedTurnCount }
            : {}),
          ...(result.restoredFileCount !== undefined
            ? { restoredFileCount: result.restoredFileCount }
            : {}),
          ...(result.undoable ? { undoable: true } : {}),
        },
      });
    } catch (error) {
      // The provider has rewound; a missing marker must not report failure.
      backendRegistryLog.warn("failed to record thread rewind", {
        backend: request.backend,
        threadId: request.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.emit({
      backend: request.backend,
      notification: {
        method: "thread/rewound",
        params: {
          threadId: request.threadId,
          ...(result.targetPromptIndex !== undefined
            ? { targetPromptIndex: result.targetPromptIndex }
            : {}),
          updatedAt: result.updatedAt,
        },
      },
    });
    return {
      backend: request.backend,
      threadId: request.threadId,
      target: request.target,
      mode: request.mode,
      updatedAt: result.updatedAt,
      rewindId,
      ...(result.promptText ? { promptText: result.promptText } : {}),
      ...(result.restoredFileCount !== undefined ? { restoredFileCount: result.restoredFileCount } : {}),
    };
  }

  async signInClaude(): Promise<void> {
    const policy = getOwnerHostServices().runtimePolicy;
    if (policy && !policy.enabledBackends.includes("claude")) throw new Error("Claude is disabled on this instance.");
    await this.claudeBackend.signIn();
  }

  /** A Claude thread whose session Claude Code deleted continues in a new
   * one, primed with the thread's own record of the conversation. */
  async continueClaudeThreadInNewSession(request: { threadId: string }): Promise<{ threadId: string }> {
    await this.assertThreadNotLocked("claude", request.threadId);
    try {
      return await this.claudeBackend.continueInNewSession(request.threadId);
    } finally {
      // A message queued behind the failed turn can go now.
      this.threadTurnQueue.scheduleThreadDrain({ backend: "claude", threadId: request.threadId });
    }
  }

  /**
   * Puts back what a rewind removed. Only Claude keeps the removed turns, and
   * only until the thread's next turn starts.
   */
  async undoThreadRewind(
    request: UndoThreadRewindRequest,
  ): Promise<UndoThreadRewindResponse> {
    if (request.backend !== "claude") {
      throw new Error("This provider cannot undo a rewind");
    }
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: "claude",
      threadId: request.threadId,
    });
    const record = overlay?.rewindLog?.find((entry) => entry.id === request.rewindId);
    if (!record?.undoable || record.undoneAt !== undefined) {
      throw new Error("This rewind can no longer be undone");
    }
    await this.assertThreadNotLocked("claude", request.threadId);
    let updatedAt: number;
    try {
      ({ updatedAt } = await this.claudeBackend.undoRewind({
        threadId: request.threadId,
        rewindId: request.rewindId,
      }));
    } finally {
      this.threadTurnQueue.scheduleThreadDrain({ backend: "claude", threadId: request.threadId });
    }
    try {
      await this.overlayStore.markThreadRewindUndone({
        backend: "claude",
        threadId: request.threadId,
        rewindId: request.rewindId,
        undoneAt: updatedAt,
      });
    } catch (error) {
      backendRegistryLog.warn("failed to record undone thread rewind", {
        threadId: request.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.emit({
      backend: "claude",
      notification: {
        method: "thread/rewound",
        params: { threadId: request.threadId, updatedAt },
      },
    });
    return {
      backend: "claude",
      threadId: request.threadId,
      rewindId: request.rewindId,
      updatedAt,
    };
  }

  private async revertCodexThread(params: {
    threadId: string;
    beforeTurnId?: string;
  }): Promise<{ updatedAt: number }> {
    if (!params.beforeTurnId) {
      throw new Error("This prompt has no Codex turn to rewind to");
    }
    if (this.closed) throw new Error("Desktop backend registry is closed");
    await this.codexRuntimeSupervisor.invalidIdRecoveryBarrier;
    await this.assertThreadNotLocked("codex", params.threadId);
    if (
      this.context.turnState.hasStartReservation(params.threadId)
      || this.threadHasActiveTurn(params.threadId, "codex")
      || this.context.turnState.hasRetry(params.threadId)
    ) {
      throw new Error("Wait for the active turn to finish before rewinding");
    }
    const beforeTurnId = params.beforeTurnId;
    // Hold the start reservation so no turn or compaction begins on this
    // thread while Codex replaces its history.
    const revertReservation = this.context.turnState.reserveStart(params.threadId, "revert", params);
    const revert = { reported: false };
    this.codexRevertsInFlight.set(params.threadId, revert);
    try {
      await this.withCodexThreadClient(params.threadId, async (client) => {
        if (!client.revertThread) {
          throw new Error("Installed Codex does not support thread rewind");
        }
        await client.revertThread({ threadId: params.threadId, beforeTurnId });
      });
    } catch (error) {
      // Codex changed the history before the request failed; readers still
      // need to reload it.
      if (revert.reported) {
        await this.emit({
          backend: "codex",
          notification: { method: "thread/rewound", params: { threadId: params.threadId, updatedAt: Date.now() } },
        });
      }
      throw error;
    } finally {
      this.codexRevertsInFlight.delete(params.threadId);
      this.context.turnState.releaseStart(params.threadId, revertReservation);
      // The reservation made the thread read as busy, so a reply sent during
      // the revert was queued. No turn ends to release it; drain here.
      this.threadTurnQueue.scheduleThreadDrain({ backend: "codex", threadId: params.threadId });
      this.codexRuntimeSupervisor.maybeDrainCodexInvalidIdRecoveries();
    }
    return { updatedAt: Date.now() };
  }

  async configureGrokWorkflowBudget(
    request: ConfigureGrokWorkflowBudgetRequest,
  ): Promise<ConfigureGrokWorkflowBudgetResponse> {
    const policy = await this.acpSessionPromptLocks.run(
      executionModeQueueKey(request.backend, request.threadId),
      async () => {
        this.assertIdleAcpThreadMutation({
          backend: request.backend,
          threadId: request.threadId,
          action: "changing workflow budgets",
        });
        return await this.acpBackend.configureWorkflowBudget({
          backend: request.backend,
          sessionId: request.threadId,
          defaultAgentBudget: request.defaultAgentBudget,
          maxAgentBudget: request.maxAgentBudget,
        });
      },
    );
    return {
      backend: request.backend,
      threadId: request.threadId,
      policy,
    };
  }

  private async submitSteerTurn(
    params: SteerTurnRequest,
    messageOrigin?: AppServerThreadMessageOrigin,
  ): Promise<ThreadSteeringSubmission> {
    // Accepted requests replay before reaching this admission boundary.
    if (this.restartGate.phase === "quieting" && messageOrigin !== QUIET_RESTART_STEER_ORIGIN) {
      throw new Error("PwrAgent is restarting. Retry after it relaunches; this message was not accepted.");
    }
    return await this.threadSteerSubmission.submit(params, messageOrigin);
  }

  private readonly threadSteerSubmission = new ThreadSteerSubmissionLifecycle({
    assertUnlocked: async (request) => {
      if (this.compactionRecoveryAdmissions.has(request.requestId)) {
        if (await this.isThreadLocked(request)) throw new CompactionRecoveryRevoked("busy");
        return;
      }
      await this.assertThreadNotLocked(request.backend, request.threadId);
    },
    isRestartGateClosed: () => this.isRestartGateClosed(),
    queue: async (params, messageOrigin, origin) => {
      // Recovery belongs only to the compacted assignment, never a later turn.
      if (messageOrigin.systemReason === "compaction-recovery") throw new CompactionRecoveryRevoked();
      const queued = await this.admitThreadAttachments(
        { backend: params.backend, threadId: params.threadId, input: params.input },
        (input, onAdmission) => this.threadTurnQueue.submitSteer({
          backend: params.backend,
          threadId: params.threadId,
          input,
          messageOrigin,
          origin,
        }, { onAdmission }),
      );
      return queued.entry;
    },
    reviewMode: (params) => this.managedReviewService.findReviewForParentTurn({
      backend: params.backend, parentThreadId: params.threadId,
    })?.mode,
    prepareInput: async (params) => await ownThreadInputAttachments(
      await enrichLocalFileInputs(params.input, {
        privateStorageRoots: this.localFilePrivateStorageRoots,
      }),
      params,
      this.localFilePrivateStorageRoots,
    ),
    steerClaude: (params, input, messageOrigin) => this.claudeBackend.steerTurn({ ...params, input, messageOrigin }),
    retainClaude: async (params, messageId, messageOrigin) => {
      await this.persistThreadMessageOrigin({ backend: "claude", threadId: params.threadId,
        messageId, origin: messageOrigin });
    },
    prepareAcp: (params, input, origin) => this.prepareAcpSteer(params, input, origin),
    prepareCodex: (params, input, origin) => this.prepareCodexSteer(params, input, origin),
  });

  private async prepareAcpSteer(
    params: SteerTurnRequest & { backend: AcpBackendId },
    input: AppServerTurnInputItem[],
    messageOrigin?: AppServerThreadMessageOrigin,
  ): Promise<PreparedAcpSteer> {
    const acpBackend = params.backend;
    const promptPayload = await inputToAcpPrompt(input, {
      owner: { backend: acpBackend, threadId: params.threadId },
      privateStorageRoots: this.localFilePrivateStorageRoots,
    });
    if (!promptPayload) {
      throw new Error("ACP steering requires text or image input");
    }
    const pendingMessageContextId = await this.registerPendingThreadMessageContext({
      backend: params.backend,
      input,
      threadId: params.threadId,
      origin: messageOrigin,
      text: extractFirstMeaningfulTextInput(params.input),
      retainAttachments: true,
    });
    const text = promptPayload.prompt
      || promptPayload.promptContent.flatMap((block) =>
        block.type === "text" && block.text.trim() ? [block.text] : []
      )[0]
      || "Additional image context.";
    return {
      submit: () => this.acpSessionPromptLocks.run(
        executionModeQueueKey(acpBackend, params.threadId),
        async () => {
          this.assertExpectedAcpSteerTurn({
            backend: acpBackend,
            threadId: params.threadId,
            expectedTurnId: params.expectedTurnId,
          });
          return await this.acpBackend.steerSession({
            backend: acpBackend,
            content: promptPayload.promptContent,
            interjectionId: params.requestId,
            sessionId: params.threadId,
            text,
          });
        },
      ),
      forget: () => this.forgetPendingThreadMessageContext(pendingMessageContextId),
      bindCurrentTurn: () => this.bindPendingThreadMessageContext(pendingMessageContextId, params.expectedTurnId),
    };
  }

  private async prepareCodexSteer(
    params: SteerTurnRequest,
    input: AppServerTurnInputItem[],
    messageOrigin?: AppServerThreadMessageOrigin,
  ): Promise<PreparedCodexSteer> {
    // A contained Outpost must refuse an unavailable workspace before the
    // provider claims guidance; the queue can then hold and retry that input.
    if (getOwnerHostServices().runtimePolicy?.exclusiveProfileOwner) {
      const cwd = await this.resolveThreadWorkspaceCwd(params.backend, params.threadId);
      if (cwd && !await stat(cwd).then(entry => entry.isDirectory(), () => false)) {
        throw new Error(`Thread workspace is unavailable: ${cwd}`);
      }
    }
    const pendingMessageContextId = await this.registerPendingThreadMessageContext({
      backend: params.backend,
      input,
      threadId: params.threadId,
      turnId: params.expectedTurnId,
      origin: messageOrigin,
      text: extractFirstMeaningfulTextInput(params.input),
    });
    return {
      submit: () => this.withActiveCodexThreadClient(params.threadId, async (client) => {
        const recovery = this.compactionRecoveryAdmissions.get(params.requestId);
        if (messageOrigin?.systemReason === "compaction-recovery") {
          if (await this.isThreadLocked(params)) throw new CompactionRecoveryRevoked("busy");
          if (!recovery?.allowed()) throw new CompactionRecoveryRevoked();
        }
        if (!client.steerTurn) {
          throw new Error("Selected backend does not support turn/steer");
        }
        return await client.steerTurn({
          threadId: params.threadId,
          input,
          ...(pendingMessageContextId ? {
            onInputTextPrepared: (text: string | undefined) => {
              this.updatePendingThreadMessageText(pendingMessageContextId, text);
            },
          } : {}),
          expectedTurnId: params.expectedTurnId,
          ...(messageOrigin?.systemReason === "compaction-recovery" ? {
            admitSteer: async (submit: () => Promise<unknown>) => {
              if (await this.isThreadLocked(params)) throw new CompactionRecoveryRevoked("busy");
              if (!recovery?.allowed() || !recovery.admit()) throw new CompactionRecoveryRevoked();
              // No await between the current owner/SQLite checks and RPC admission.
              return submit();
            },
          } : {}),
        });
      }),
      forget: () => this.forgetPendingThreadMessageContext(pendingMessageContextId),
      retain: async (result) => {
        await this.rememberTurnInputAttachments({
          backend: params.backend,
          threadId: result.threadId,
          turnId: result.turnId,
          input,
        });
      },
    };
  }

  /**
   * User-facing entry point for permission-mode changes. Decides
   * queue-vs-apply based on whether a turn is currently in flight on
   * the thread.
   *
   * Codex's `thread/resume` rejects (or warn-and-ignores) permission
   * overrides while a turn is running, so the only legal moment to
   * change a thread's permission profile is the resume boundary — i.e.
   * turn-end. Toggles received during an active turn are queued in
   * registry memory and flushed automatically on `thread/status/changed
   * → idle` (or just before the next `turn/start`, whichever fires
   * first). See the state-machine diagram in the Phase 2 plan for the
   * full transition table.
   */
  async setThreadExecutionMode(
    params: SetThreadExecutionModeRequest
  ): Promise<SetThreadExecutionModeResponse> {
    return await this.executionModeSelectionLocks.run(
      executionModeQueueKey(params.backend, params.threadId),
      () => this.setThreadExecutionModeOnce(params),
    );
  }

  private async setThreadExecutionModeOnce(
    params: SetThreadExecutionModeRequest,
  ): Promise<SetThreadExecutionModeResponse> {
    if (params.backend === "claude") {
      if (await this.claudeBackend.executionMode(params.threadId) === params.executionMode) return params;
      await this.claudeBackend.setExecutionMode(params.threadId, params.executionMode);
      await this.overlayStore.setThreadExecutionMode(params);
      await this.emit({ backend: "claude", notification: { method: "thread/executionMode/updated", params } });
      return params;
    }
    if (params.backend !== "codex") {
      if (params.executionMode === "auto") {
        throw new Error("Auto access is supported only by Codex.");
      }
      if (
        isAcpBackendId(params.backend) &&
        this.usesSlashControlledAcpExecutionModes(params.backend)
      ) {
        return await this.setSlashControlledAcpExecutionMode({
          ...params,
          backend: params.backend,
        });
      }
      // ACP backends without a slash-driven approval-policy toggle (e.g.
      // Gemini today) currently no-op on execution mode — no overlay
      // write, no backend change. We still emit on the bus so all
      // surfaces stay visually consistent with the user's click. The
      // optimistic UI is the same lie either way; symmetric emission is
      // better than partial fan-out.
      await this.emit({
        backend: params.backend,
        notification: {
          method: "thread/executionMode/updated",
          params: {
            threadId: params.threadId,
            executionMode: params.executionMode,
          },
        },
      });
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: params.executionMode,
      };
    }

    await this.queuedExecutionModeFlushes.get(executionModeQueueKey("codex", params.threadId));
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: params.threadId,
    });
    const currentApplied = overlay?.executionMode ?? "default";
    const hasActiveTurn = this.threadHasActiveTurn(params.threadId, "codex");
    const queueKey = executionModeQueueKey("codex", params.threadId);
    const hasQueue = this.queuedExecutionModes.has(queueKey);

    // Toggling back to the currently-applied mode while a queue is
    // pending is a cancel — the user changed their mind. No codex call,
    // no overlay flip.
    if (hasQueue && params.executionMode === currentApplied) {
      await this.cancelThreadExecutionModeQueue({
        backend: "codex",
        threadId: params.threadId,
      });
      return {
        backend: "codex",
        threadId: params.threadId,
        executionMode: currentApplied,
      };
    }

    if (hasActiveTurn && params.executionMode === currentApplied) {
      return { backend: "codex", threadId: params.threadId, executionMode: currentApplied };
    }
    const active = this.getActiveTurnForThread(params);
    // A review registers its child's turn on the parent to hold the
    // parent's queue. That synthetic pairing is not a live Codex turn target.
    const review = active && this.managedReviewService.findReviewForParentTurn({
      backend: params.backend,
      parentThreadId: params.threadId,
      turnId: active.turnId,
    });
    const activeStart = this.context.turnState.retryOperation(params.threadId);
    const customBoundary = activeStart?.kind === "turn"
      && activeStart.turnId === active?.turnId
      && ((activeStart?.params.sandbox && activeStart.params.sandbox !== "workspace-write")
        || (activeStart?.params.approvalPolicy && activeStart.params.approvalPolicy !== "on-request"));
    if (
      active
      && !review
      && !customBoundary
      && this.findActiveCodexThreadMode(params.threadId) !== "full-access"
      && params.executionMode !== currentApplied
      && params.executionMode !== "full-access"
      && currentApplied !== "full-access"
    ) {
      const applying = this.applyThreadExecutionMode(params, { activeTurnId: active.turnId });
      // Turn completion and a following start must observe the saved reviewer.
      // The requester receives errors; later turns continue with the old mode.
      const settled = applying.then(() => undefined, () => undefined);
      this.queuedExecutionModeFlushes.set(queueKey, settled);
      try {
        return await applying;
      } finally {
        if (this.queuedExecutionModeFlushes.get(queueKey) === settled) {
          this.queuedExecutionModeFlushes.delete(queueKey);
        }
      }
    }

    // Reviews, sandbox changes, and starts without a turn id must wait.
    // Active turn → queue. No codex call, no overlay executionMode flip.
    if (hasActiveTurn && params.executionMode !== currentApplied) {
      const queued = await this.queueThreadExecutionMode(params);
      // The user-facing setThreadExecutionMode response shape is
      // SetThreadExecutionModeResponse — we report the queued mode as
      // the "executionMode" so callers see the thing they intended,
      // even though it isn't applied yet. The queued state is also
      // surfaced via the `thread/executionMode/queued` bus event for
      // surfaces that need to render the pending-state distinct from
      // the applied state.
      return {
        backend: "codex",
        threadId: params.threadId,
        executionMode: queued.queuedExecutionMode,
      };
    }

    // No active turn → apply immediately.
    return await this.applyThreadExecutionMode(params);
  }

  private async setSlashControlledAcpExecutionMode(
    params: SetThreadExecutionModeRequest & { backend: AcpBackendId },
  ): Promise<SetThreadExecutionModeResponse> {
    const currentApplied = await this.readAppliedExecutionMode(
      params.backend,
      params.threadId,
    );
    const hasActiveTurn = this.threadHasActiveTurn(params.threadId, params.backend);
    const queueKey = executionModeQueueKey(params.backend, params.threadId);
    const hasQueue = this.queuedExecutionModes.has(queueKey);

    if (hasQueue && params.executionMode === currentApplied) {
      await this.cancelThreadExecutionModeQueue({
        backend: params.backend,
        threadId: params.threadId,
      });
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: currentApplied,
      };
    }

    if (params.executionMode === currentApplied) {
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: currentApplied,
      };
    }

    if (hasActiveTurn && params.executionMode !== currentApplied) {
      const queued = await this.queueThreadExecutionMode(params);
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: queued.queuedExecutionMode,
      };
    }

    return await this.applyThreadExecutionMode(params);
  }

  /**
   * Snapshot of in-memory queued execution modes keyed by thread identity.
   * Consumed by the navigation snapshot path so the renderer sees
   * queued state on the very first snapshot after restart, without
   * waiting for a follow-up bus event. The queue map itself is not
   * persisted — but the audit log entries are, so historical context
   * survives restarts.
   */
  /**
   * Read projection of the main-process turn FIFO, keyed by thread
   * identity. Mirrors getQueuedExecutionModesSnapshot: the queue itself
   * is registry memory, but every navigation snapshot carries this so
   * ALL windows — the owner's, other local windows, and federated
   * viewers — can render and rehydrate queued messages instead of only
   * the window that submitted them.
   */
  getQueuedTurnsForThread(ref: { backend: AppServerBackendKind; threadId: string }): ThreadQueuedTurnSummary[] {
    return [...this.iterateQueuedTurnSummaries(ref)];
  }

  *iterateQueuedTurnSummaries(ref: { backend: AppServerBackendKind; threadId: string }): IterableIterator<ThreadQueuedTurnSummary> {
    let position = 0;
    for (const entry of this.threadTurnQueue.iterateQueuedEntries(ref)) {
      yield {
        queueEntryId: entry.id,
        origin: entry.origin,
        displayText: queuedTurnDisplayText(entry.input),
        createdAt: entry.createdAt,
        position: position++,
        ...(entry.manualReleaseRequired ? { manualReleaseRequired: true } : {}),
        ...(entry.holdReason ? { holdReason: entry.holdReason } : {}),
        ...queuedTurnPauseParams(entry),
        ...(entry.title ? { title: entry.title } : {}),
      };
    }
  }

  getQueuedExecutionModeForThread(ref: { backend: AppServerBackendKind; threadId: string }) {
    const entry = this.queuedExecutionModes.get(buildThreadIdentityKey(ref.backend, ref.threadId));
    return entry ? { mode: entry.mode, queuedAt: entry.queuedAt } : undefined;
  }

  getQueuedTurnsSnapshot(): Record<string, ThreadQueuedTurnSummary[]> {
    const snapshot: Record<string, ThreadQueuedTurnSummary[]> = {};
    for (const entry of this.threadTurnQueue.getAllQueuedEntries()) {
      const threadKey = buildThreadIdentityKey(entry.backend, entry.threadId);
      const queue = snapshot[threadKey] ?? [];
      queue.push({
        queueEntryId: entry.id,
        origin: entry.origin,
        displayText: queuedTurnDisplayText(entry.input),
        createdAt: entry.createdAt,
        position: queue.length,
        ...(entry.manualReleaseRequired
          ? { manualReleaseRequired: true }
          : {}),
        ...(entry.holdReason ? { holdReason: entry.holdReason } : {}),
        ...queuedTurnPauseParams(entry),
        ...(entry.title ? { title: entry.title } : {}),
      });
      snapshot[threadKey] = queue;
    }
    return snapshot;
  }

  getQueuedExecutionModesSnapshot(): Record<
    string,
    { mode: ThreadExecutionMode; queuedAt: number } | undefined
  > {
    const snapshot: Record<
      string,
      { mode: ThreadExecutionMode; queuedAt: number }
    > = {};
    for (const [queueKey, entry] of this.queuedExecutionModes) {
      snapshot[queueKey] = {
        mode: entry.mode,
        queuedAt: entry.queuedAt,
      };
    }
    return snapshot;
  }

  private usesKimiSlashExecutionModes(
    backend: AppServerBackendKind,
  ): backend is AcpBackendId {
    if (!isAcpBackendId(backend)) {
      return false;
    }
    const agent = this.acpBackend.getInstalledAgent(backend);
    if (agent?.registryId !== "kimi") {
      return false;
    }
    // Once kimi advertises its own runtime mode selector (Default/Plan/Auto/
    // Yolo via session capabilities), the legacy `/yolo` slash command is both
    // obsolete and rejected by current kimi (#658). The runtime "yolo" mode —
    // set over the standard `session/set_mode` protocol method — is the
    // approval-policy control instead, so never drive kimi through the slash
    // path in that case. Falls back to `/yolo` only for a kimi build that
    // exposes no runtime mode selector of its own.
    return !acpAdvertisesRuntimeModeSelector(agent.runtimeCapabilities);
  }

  private usesGrokSlashExecutionModes(
    backend: AppServerBackendKind,
  ): backend is AcpBackendId {
    if (!isAcpBackendId(backend)) {
      return false;
    }
    const agent = this.acpBackend.getInstalledAgent(backend);
    // A native permission selector can include Grok's Auto reviewer. Once
    // advertised, it owns permission state; /always-approve cannot represent
    // Auto and must not overwrite it during launch or mode changes.
    return agent?.registryId === "grok"
      && (findAcpPermissionModeConfigOption(agent.runtimeCapabilities)?.values.length ?? 0) < 2;
  }

  /**
   * Umbrella for ACP backends whose Default/Full Access toggle is driven by
   * a slash command sent over `session/prompt` (rather than a first-class
   * protocol method or a relaunch). Kimi uses `/yolo`; Grok uses
   * `/always-approve on|off`. Both share the same orchestration: queue
   * during active turns, flush at turn-end, write per-thread audit log,
   * emit `thread/executionMode/updated` on the bus. The per-agent slash
   * command text + response handling lives in the apply*ControlPrompt
   * helpers.
   */
  private usesSlashControlledAcpExecutionModes(
    backend: AppServerBackendKind,
  ): backend is AcpBackendId {
    return (
      this.usesKimiSlashExecutionModes(backend) ||
      this.usesGrokSlashExecutionModes(backend)
    );
  }

  private backendUsesQueuedExecutionModes(
    backend: AppServerBackendKind,
  ): boolean {
    return (
      backend === "codex" || this.usesSlashControlledAcpExecutionModes(backend)
    );
  }

  private async readAppliedExecutionMode(
    backend: AppServerBackendKind,
    threadId: string,
  ): Promise<ThreadExecutionMode> {
    if (backend === "claude") return this.claudeBackend.executionMode(threadId);
    if (backend === "codex") {
      const overlay = await this.overlayStore.getThreadOverlayState({
        backend,
        threadId,
      });
      return overlay?.executionMode ?? "default";
    }
    if (this.usesSlashControlledAcpExecutionModes(backend)) {
      const overlay = await this.overlayStore.getThreadOverlayState({
        backend,
        threadId,
      });
      return (
        this.latestAppliedExecutionModeFromOverlay(overlay) ??
        this.acpBackend.getSession(backend, threadId)?.executionMode ?? "default"
      );
    }
    return "default";
  }

  private latestAppliedExecutionModeFromOverlay(
    overlay: ThreadOverlayState | undefined,
  ): ThreadExecutionMode | undefined {
    return [...(overlay?.permissionTransitionLog ?? [])]
      .reverse()
      .find((transition) => transition.status === "applied")
      ?.toExecutionMode;
  }

  async queueThreadExecutionMode(
    params: QueueThreadExecutionModeRequest,
  ): Promise<QueueThreadExecutionModeResponse> {
    if (!this.backendUsesQueuedExecutionModes(params.backend)) {
      // Non-codex backends don't have a queue concept; fall through to
      // immediate apply so the caller observes consistent semantics.
      await this.setThreadExecutionMode(params);
      return {
        backend: params.backend,
        threadId: params.threadId,
        queuedExecutionMode: params.executionMode,
        queuedAt: Date.now(),
      };
    }

    const currentApplied = await this.readAppliedExecutionMode(
      params.backend,
      params.threadId,
    );
    const queuedAt = Date.now();
    const queueId = randomUUID();

    const queueKey = executionModeQueueKey(params.backend, params.threadId);

    this.queuedExecutionModes.set(queueKey, {
      backend: params.backend,
      mode: params.executionMode,
      queuedAt,
      queueId,
      flushAttempts: 0,
    });

    await this.appendPermissionTransition({
      backend: params.backend,
      threadId: params.threadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: currentApplied,
        toExecutionMode: params.executionMode,
        status: "queued",
        occurredAt: queuedAt,
        queueId,
      },
    });

    backendRegistryLog.info("queued thread execution mode change", {
      threadId: params.threadId,
      from: currentApplied,
      to: params.executionMode,
      queueId,
    });

    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/executionMode/queued",
        params: {
          threadId: params.threadId,
          queuedExecutionMode: params.executionMode,
          queuedAt,
        },
      },
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      queuedExecutionMode: params.executionMode,
      queuedAt,
    };
  }

  async cancelThreadExecutionModeQueue(
    params: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse> {
    const currentApplied = await this.readAppliedExecutionMode(
      params.backend,
      params.threadId,
    );

    const queue =
      this.backendUsesQueuedExecutionModes(params.backend)
        ? this.queuedExecutionModes.get(
            executionModeQueueKey(params.backend, params.threadId),
          )
        : undefined;
    if (!queue) {
      // Idempotent: cancel of nothing is a no-op that returns the
      // current applied mode.
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: currentApplied,
      };
    }

    this.queuedExecutionModes.delete(
      executionModeQueueKey(params.backend, params.threadId),
    );

    await this.appendPermissionTransition({
      backend: params.backend,
      threadId: params.threadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: currentApplied,
        toExecutionMode: queue.mode,
        status: "cancelled",
        occurredAt: Date.now(),
        queueId: queue.queueId,
      },
    });

    backendRegistryLog.info("cancelled queued thread execution mode change", {
      threadId: params.threadId,
      from: currentApplied,
      to: queue.mode,
      queueId: queue.queueId,
    });

    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/executionMode/queueCleared",
        params: {
          threadId: params.threadId,
          reason: "cancelled",
        },
      },
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: currentApplied,
    };
  }

  /**
   * Actually apply a permission-mode change to codex. Called from both
   * the immediate-apply path (toggle while idle) and the queue-flush
   * path (turn-end). When called from the queue, `fromQueue: true`
   * propagates the queue's `queueId` into the resulting `applied`
   * audit entry and emits the matching `queueCleared(applied)` event.
   */
  private async applyThreadExecutionMode(
    params: SetThreadExecutionModeRequest,
    options?: { fromQueue?: boolean; queueId?: string; activeTurnId?: string },
  ): Promise<SetThreadExecutionModeResponse> {
    if (params.backend !== "codex") {
      if (params.executionMode === "auto") {
        throw new Error("Auto access is supported only by Codex.");
      }
      if (
        isAcpBackendId(params.backend) &&
        this.usesSlashControlledAcpExecutionModes(params.backend)
      ) {
        return await this.applySlashControlledAcpThreadExecutionMode(
          {
            ...params,
            backend: params.backend,
          },
          options,
        );
      }
      // No-op path for ACP backends without a slash-driven toggle.
      // Direct callers route through setThreadExecutionMode which
      // short-circuits before reaching this method, so we should never
      // get here, but guard anyway.
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: params.executionMode,
      };
    }

    const previousOverlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: params.threadId,
    });
    const previousApplied = previousOverlay?.executionMode ?? "default";

    const modeSettings = executionModeSettings(params.executionMode);
    const result = await this.withCodexThreadClient(
      params.threadId,
      async (client) => {
        if (options?.activeTurnId) {
          if (!client.setTurnApprovalReviewer) {
            throw new Error("This Codex runtime cannot change the approval reviewer during a turn.");
          }
          const result = await client.setTurnApprovalReviewer({
            threadId: params.threadId,
            turnId: options.activeTurnId,
            approvalsReviewer: modeSettings.approvalsReviewer,
          });
          if (result.status !== "applied") {
            throw new Error("The active turn changed before Auto access could be updated. Select the access mode again.");
          }
          // Every future turn receives the persisted mode's reviewer explicitly.
          // Do not resume the thread or change its sandbox during a running turn.
          const key = buildActiveTurnModeKey(params.threadId, options.activeTurnId);
          if (this.context.turnState.ownsExecution(key)) {
            this.context.turnState.changeExecution(key, params.executionMode);
          }
          return { threadId: params.threadId };
        }
        if (!client.setThreadPermissions) {
          throw new Error(
            "Selected backend does not support execution mode updates",
          );
        }
        return await client.setThreadPermissions({
          threadId: params.threadId,
          approvalPolicy: modeSettings.approvalPolicy,
          approvalsReviewer: modeSettings.approvalsReviewer,
          sandbox: modeSettings.sandbox,
        });
      },
    );

    const resolvedThreadId = result.threadId;
    if (options?.activeTurnId && this.queuedExecutionModes.has(executionModeQueueKey("codex", params.threadId))) {
      await this.cancelThreadExecutionModeQueue(params);
    }

    await this.overlayStore.setThreadExecutionMode({
      backend: "codex",
      threadId: resolvedThreadId,
      executionMode: params.executionMode,
    });

    // The queueId (if this apply came from a queue flush) is passed
    // through `options.queueId` because the flush atomically claimed
    // the queue (deleted from the map) before calling apply — so we
    // can't read it back from `queuedExecutionModes` here. Direct
    // applies (idle path) leave it undefined.
    const queueIdForAuditLink = options?.queueId;

    await this.appendPermissionTransition({
      threadId: resolvedThreadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: previousApplied,
        toExecutionMode: params.executionMode,
        status: "applied",
        occurredAt: Date.now(),
        queueId: queueIdForAuditLink,
      },
    });

    await this.emit({
      backend: "codex",
      notification: {
        method: "thread/executionMode/updated",
        params: {
          threadId: resolvedThreadId,
          executionMode: params.executionMode,
        },
      },
    });

    if (options?.fromQueue) {
      // Order matters: clients must see the apply BEFORE the
      // queue-clear. The applied transition is now in the log; the
      // overlay's executionMode is current. The queue map entry was
      // already atomically claimed (deleted) by
      // flushQueuedExecutionModeIfPresent before we ran, so just
      // emit the event for downstream listeners.
      await this.emit({
        backend: "codex",
        notification: {
          method: "thread/executionMode/queueCleared",
          params: {
            threadId: resolvedThreadId,
            reason: "applied",
          },
        },
      });
    }

    return {
      backend: "codex",
      threadId: resolvedThreadId,
      executionMode: params.executionMode,
    };
  }

  private async applySlashControlledAcpThreadExecutionMode(
    params: SetThreadExecutionModeRequest & { backend: AcpBackendId },
    options?: { fromQueue?: boolean; queueId?: string },
  ): Promise<SetThreadExecutionModeResponse> {
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session) {
      throw new Error(`ACP session not found: ${params.threadId}`);
    }
    const previousApplied = session.executionMode ?? "default";
    const client = await this.acpBackend.getClientForSession(
      params.backend,
      params.threadId,
    );
    await client.ensureSession?.(session);
    const registryId = this.acpBackend.getInstalledAgent(params.backend)
      ?.registryId;
    if (registryId === "kimi") {
      await this.applyKimiAcpExecutionModeControlPrompt({
        backend: params.backend,
        client,
        sessionId: params.threadId,
        fromExecutionMode: previousApplied,
        toExecutionMode: params.executionMode,
      });
    } else if (registryId === "grok") {
      await this.applyGrokAcpExecutionModeControlPrompt({
        backend: params.backend,
        client,
        sessionId: params.threadId,
        fromExecutionMode: previousApplied,
        toExecutionMode: params.executionMode,
      });
    } else {
      throw new Error(
        `Unsupported slash-controlled ACP registry: ${registryId ?? "<unknown>"}`,
      );
    }

    const updatedAt = Date.now();
    this.acpBackend.upsertSession({
      ...session,
      executionMode: params.executionMode,
      updatedAt: Math.max(session.updatedAt, updatedAt),
    });
    await this.overlayStore.setThreadExecutionMode({
      backend: params.backend,
      threadId: params.threadId,
      executionMode: params.executionMode,
      updatedAt,
    });

    await this.appendPermissionTransition({
      backend: params.backend,
      threadId: params.threadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: previousApplied,
        toExecutionMode: params.executionMode,
        status: "applied",
        occurredAt: updatedAt,
        queueId: options?.queueId,
      },
    });

    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/executionMode/updated",
        params: {
          threadId: params.threadId,
          executionMode: params.executionMode,
        },
      },
    });

    if (options?.fromQueue) {
      await this.emit({
        backend: params.backend,
        notification: {
          method: "thread/executionMode/queueCleared",
          params: {
            threadId: params.threadId,
            reason: "applied",
          },
        },
      });
    }

    return {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: params.executionMode,
    };
  }

  private async applyKimiAcpExecutionModeControlPrompt(params: {
    backend: AcpBackendId;
    client: AcpRuntimeClient;
    sessionId: string;
    fromExecutionMode: ThreadExecutionMode;
    toExecutionMode: ThreadExecutionMode;
  }): Promise<void> {
    if (!this.usesKimiSlashExecutionModes(params.backend)) {
      return;
    }
    if (params.fromExecutionMode === params.toExecutionMode) {
      return;
    }
    const client = params.client;
    if (!client.sendControlPrompt) {
      throw new Error("Kimi ACP execution mode updates require control prompts");
    }
    const result = await this.acpSessionPromptLocks.run(
      executionModeQueueKey(params.backend, params.sessionId),
      async () =>
        await client.sendControlPrompt!({
          sessionId: params.sessionId,
          prompt: "/yolo",
        }),
    );
    const observedMode = readKimiYoloExecutionModeFromText(result.text);
    if (observedMode !== params.toExecutionMode) {
      const target = formatExecutionModeForError(params.toExecutionMode);
      const observed = observedMode
        ? formatExecutionModeForError(observedMode)
        : "unknown state";
      throw new Error(
        `Kimi ACP /yolo did not confirm ${target}; observed ${observed}`,
      );
    }
  }

  /**
   * Grok exposes Default/Full Access via `/always-approve on` and
   * `/always-approve off` (per the `availableCommands` advertised in its
   * `initialize` response — name "always-approve", hint "on|off"). Unlike
   * Kimi's `/yolo`, Grok's slash command returns no `agent_message_chunk`
   * — the only success signal is a clean `end_turn` `session/prompt`
   * response, and `/session-info` does NOT reflect the toggled state
   * (verified by probe). So we trust `sendControlPrompt` resolving
   * without a JSON-RPC error as success; the only failure modes we can
   * detect are transport errors and a non-end_turn stopReason, both of
   * which surface as thrown exceptions from the client.
   */
  private async applyGrokAcpExecutionModeControlPrompt(params: {
    backend: AcpBackendId;
    client: AcpRuntimeClient;
    sessionId: string;
    fromExecutionMode: ThreadExecutionMode;
    toExecutionMode: ThreadExecutionMode;
  }): Promise<void> {
    if (!this.usesGrokSlashExecutionModes(params.backend)) {
      return;
    }
    if (params.fromExecutionMode === params.toExecutionMode) {
      return;
    }
    const client = params.client;
    if (!client.sendControlPrompt) {
      throw new Error("Grok ACP execution mode updates require control prompts");
    }
    const command =
      params.toExecutionMode === "full-access"
        ? "/always-approve on"
        : "/always-approve off";
    await this.acpSessionPromptLocks.run(
      executionModeQueueKey(params.backend, params.sessionId),
      async () =>
        await client.sendControlPrompt!({
          sessionId: params.sessionId,
          prompt: command,
        }),
    );
  }

  /** Sequence-fenced provider evidence is owned by the activity reducer. */
  private reconcileBackendCodexThreadStatus(
    threadId: string,
    status: string | undefined,
    sequence = this.reserveCodexThreadStatusObservationSequence(),
  ): void {
    if (!isAppServerThreadStatus(status)) {
      return;
    }
    this.context.turnState.observeStatus(threadId, status, sequence);
  }

  private reserveCodexThreadStatusObservationSequence(): number {
    return this.context.turnState.reserveStatusSequence();
  }

  private seedBackendCodexThreadStatus(
    threadId: string,
    status: AppServerThreadStatus | undefined,
  ): void {
    this.context.turnState.seedStatus(threadId, status);
  }

  private reconcileCodexThreadListStatus(
    thread: AppServerThreadSummary,
  ): AppServerThreadSummary {
    const observation = this.context.turnState.statusObservation(thread.id);
    if (!observation) {
      this.seedBackendCodexThreadStatus(thread.id, thread.threadStatus);
      return thread;
    }
    const observedStatus = observation.status;

    // Codex review flows can emit an idle boundary for one turn while another
    // tracked turn remains active. In-memory turn ownership wins in that case;
    // retain the observation so the next genuine terminal event can settle it.
    const reconciledStatus =
      observedStatus !== "active" && this.threadHasActiveTurn(thread.id)
        ? "active"
        : observedStatus;
    this.seedBackendCodexThreadStatus(thread.id, reconciledStatus);
    if (thread.threadStatus === reconciledStatus) {
      if (
        reconciledStatus === observedStatus
        && this.context.turnState.statusObservation(thread.id) === observation
        // Keep a locally owned turn's observation until its terminal event.
        // A later, older discovery row must not erase accepted activity after
        // one provider row acknowledges the start. Check ownership only for
        // active observations, rather than scanning turns for every idle row.
        && !(observedStatus === "active" && (
          this.context.turnState.hasStartReservation(thread.id)
          || this.getActiveTurnForThread({ backend: "codex", threadId: thread.id })
        ))
      ) {
        this.context.turnState.acknowledgeObservation(thread.id, observation);
      }
      return thread;
    }

    return {
      ...thread,
      threadStatus: reconciledStatus,
    };
  }

  private threadHasActiveTurn(
    threadId: string,
    backend: AppServerBackendKind = "codex",
    ignoreCodexStartReservation = false,
  ): boolean {
    if (this.managedReviewService.findReviewForParentTurn({ backend, parentThreadId: threadId })) {
      return true;
    }
    if (backend === "codex") {
      return this.context.turnState.hasActiveTurn(threadId, ignoreCodexStartReservation);
    }
    if (this.reservedAcpStartThreadKeys.has(
      buildTurnStartReservationKey(backend, threadId),
    )) {
      return true;
    }
    const prefix = `${backend}:${threadId}:`;
    for (const key of this.context.turnState.registeredTurnKeys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  private threadHasActiveCodexReviewTurn(threadId: string): boolean {
    return Boolean(this.findActiveCodexReviewTurnKey(threadId))
      || this.managedReviewService.findReviewForParentTurn({ backend: "codex", parentThreadId: threadId })?.mode === "native";
  }

  private findActiveCodexReviewTurnKey(threadId: string): string | undefined {
    const prefix = `${threadId}:`;
    for (const key of this.context.turnState.reviewKeys()) {
      if (key.startsWith(prefix)) {
        return key;
      }
    }
    return undefined;
  }

  private clearCodexReviewInterruptMappingForTurn(
    threadId: string,
    turnId: string,
  ): void {
    const activeTurnModeKey = buildActiveTurnModeKey(threadId, turnId);
    this.context.turnState.forgetReviewInterrupt(activeTurnModeKey);
    for (const [reviewTurnKey, interruptTurnId] of Array.from(
      this.context.turnState.reviewInterruptEntries()
    )) {
      if (
        reviewTurnKey.startsWith(`${threadId}:`) &&
        interruptTurnId === turnId
      ) {
        this.context.turnState.forgetReviewInterrupt(reviewTurnKey);
      }
    }
  }

  private async resolveCodexThreadExecutionModeForActiveTurn(
    threadId: string,
  ): Promise<ThreadExecutionMode> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId,
    });
    return overlay?.executionMode ?? "default";
  }

  /**
   * Append a permission-transition entry to the overlay-store audit
   * log. Soft-fails on overlay-store errors so a transient persistence
   * failure does not block the queue state machine — the in-memory
   * state remains correct, and the bus notification still fires.
   */
  private async appendPermissionTransition(params: {
    backend?: AppServerBackendKind;
    threadId: string;
    transition: ThreadPermissionTransition;
  }): Promise<void> {
    try {
      await this.overlayStore.appendPermissionTransition({
        backend: params.backend ?? "codex",
        threadId: params.threadId,
        transition: params.transition,
      });
    } catch (error) {
      backendRegistryLog.error("failed to append permission transition", {
        backend: params.backend ?? "codex",
        threadId: params.threadId,
        status: params.transition.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Persist a backend `turn/failed` outcome to the thread overlay so the
   * renderer can materialize a durable `turn-failed:<turnId>` transcript
   * entry. Codex does not persist a failure marker in its own transcript,
   * so without this the failure vanishes on the next `readThread`. Called
   * from `emit()` before the renderer fan-out so the entry is present when
   * the navigation snapshot refreshes.
   */
  private async appendTurnFailure(params: {
    backend?: AppServerBackendKind;
    threadId: string;
    failure: ThreadTurnFailure;
  }): Promise<void> {
    try {
      await this.overlayStore.appendTurnFailure({
        backend: params.backend ?? "codex",
        threadId: params.threadId,
        failure: params.failure,
      });
    } catch (error) {
      backendRegistryLog.error("failed to append turn failure", {
        backend: params.backend ?? "codex",
        threadId: params.threadId,
        turnId: params.failure.turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async recordQuestionnaireActivity(params: {
    backend: AppServerBackendKind;
    notification: AppServerToolRequestUserInputNotification;
    response: SubmitServerRequestRequest["response"];
  }): Promise<boolean> {
    const notificationParams = params.notification.params;
    const questions = Array.isArray(notificationParams.questions)
      ? notificationParams.questions
      : [];
    if (questions.length === 0) {
      return false;
    }
    const now = Date.now();
    const pendingActivity: ThreadQuestionnaireActivity = {
      id: `questionnaire:${notificationParams.requestId}`,
      requestId: notificationParams.requestId,
      threadId: notificationParams.threadId,
      turnId: notificationParams.turnId,
      itemId: notificationParams.itemId,
      status: "pending",
      questions: questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        isOther: question.isOther,
        isSecret: question.isSecret,
        options:
          question.options?.map((option) => ({
            label: option.label,
            description: option.description,
          })) ?? undefined,
      })),
      createdAt: now,
      updatedAt: now,
    };
    const answers = sanitizeQuestionnaireResponseForOverlay({
      activity: pendingActivity,
      response: params.response,
    });
    const hasAnswers = Object.values(answers).some(questionnaireAnswerHasValue);
    const activity: ThreadQuestionnaireActivity = {
      ...pendingActivity,
      status: hasAnswers ? "submitted" : "cancelled",
      answers,
    };

    try {
      await this.overlayStore.appendQuestionnaireActivity({
        backend: params.backend,
        threadId: notificationParams.threadId,
        activity,
      });
      return true;
    } catch (error) {
      backendRegistryLog.error("failed to record questionnaire activity", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
        requestId: notificationParams.requestId,
        threadId: notificationParams.threadId,
      });
      return false;
    }
  }

  /**
   * Flush any queued permission-mode change for the given thread.
   * Called from two places:
   *  - the `emit()` listener when codex reports `thread/status/changed
   *    → idle` (or `turn/completed`), as the natural turn-end signal.
   *  - the top of `startTurn`/`startReview` for codex, to guarantee
   *    the queue applies BEFORE the next turn or review fires
   *    (race-safe ordering).
   *
   * Idempotent: a no-op when no queue is present. On apply error, the
   * queue is retained and the failure counter is incremented; after
   * `MAX_QUEUE_FLUSH_ATTEMPTS` consecutive failures, the queue is
   * auto-cancelled with an explanatory note in the audit log.
   */
  private async flushQueuedExecutionModeIfPresent(
    threadId: string,
    backend: AppServerBackendKind = "codex",
  ): Promise<void> {
    const queueKey = executionModeQueueKey(backend, threadId);
    const activeFlush = this.queuedExecutionModeFlushes.get(queueKey);
    if (activeFlush) {
      await activeFlush;
      return;
    }

    const queue = this.queuedExecutionModes.get(queueKey);
    if (!queue) return;
    // Atomic claim: in JS's single-threaded event loop, `Map.delete`
    // returning true gives this caller exclusive ownership of the
    // apply. Concurrent flushes (one from the emit-listener turn-end
    // hook, one from startTurn's race-safe prefix) both see the same
    // queue but only one's delete returns true — the other no-ops.
    // Without this, both callers race on applyThreadExecutionMode and
    // each appends a duplicate "applied" transition entry.
    if (!this.queuedExecutionModes.delete(queueKey)) {
      return;
    }

    const flush = this.applyClaimedQueuedExecutionMode(threadId, queueKey, queue);
    this.queuedExecutionModeFlushes.set(queueKey, flush);
    try {
      await flush;
    } finally {
      if (this.queuedExecutionModeFlushes.get(queueKey) === flush) {
        this.queuedExecutionModeFlushes.delete(queueKey);
      }
    }
  }

  private async applyClaimedQueuedExecutionMode(
    threadId: string,
    queueKey: string,
    queue: {
      backend: AppServerBackendKind;
      mode: ThreadExecutionMode;
      queuedAt: number;
      queueId: string;
      flushAttempts: number;
    },
  ): Promise<void> {
    try {
      await this.applyThreadExecutionMode(
        {
          backend: queue.backend,
          threadId,
          executionMode: queue.mode,
        },
        { fromQueue: true, queueId: queue.queueId },
      );
    } catch (error) {
      const attempts = queue.flushAttempts + 1;
      const stillRetained = this.queuedExecutionModes.get(queueKey);
      if (stillRetained && stillRetained.queueId !== queue.queueId) {
        // The queue was replaced while we were mid-apply (the user
        // queued a different target). Discard our retry — the new
        // state wins.
        return;
      }
      if (attempts >= MAX_QUEUE_FLUSH_ATTEMPTS) {
        backendRegistryLog.error(
          "auto-cancelling queued execution mode change after repeated failures",
          {
            threadId,
            queueId: queue.queueId,
            attempts,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        const overlay = await this.overlayStore
          .getThreadOverlayState({ backend: queue.backend, threadId })
          .catch(() => undefined);
        const currentApplied =
          queue.backend === "codex"
            ? overlay?.executionMode ?? "default"
            : await this.readAppliedExecutionMode(queue.backend, threadId);
        this.queuedExecutionModes.delete(queueKey);
        await this.appendPermissionTransition({
          backend: queue.backend,
          threadId,
          transition: {
            id: randomUUID(),
            fromExecutionMode: currentApplied,
            toExecutionMode: queue.mode,
            status: "cancelled",
            occurredAt: Date.now(),
            queueId: queue.queueId,
            note: `auto-cancelled after ${MAX_QUEUE_FLUSH_ATTEMPTS} failed flush attempts`,
          },
        });
        await this.emit({
          backend: queue.backend,
          notification: {
            method: "thread/executionMode/queueCleared",
            params: {
              threadId,
              reason: "cancelled",
            },
          },
        });
        return;
      }
      this.queuedExecutionModes.set(queueKey, {
        ...queue,
        flushAttempts: attempts,
      });
      backendRegistryLog.warn("queued execution mode flush failed; will retry", {
        threadId,
        queueId: queue.queueId,
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // A thread's MCP connection selection, owned by ThreadMcpConnections.
  readThreadMcpConnections(
    request: ReadThreadMcpConnectionsRequest,
  ): Promise<SetThreadMcpConnectionsResponse> {
    return this.threadMcpConnections.readThreadMcpConnections(request);
  }

  describeThreadMcpConnections(
    request: DescribeThreadMcpConnectionsRequest,
  ): Promise<DescribeThreadMcpConnectionsResponse> {
    return this.threadMcpConnections.describeThreadMcpConnections(request);
  }

  setThreadMcpConnections(
    request: SetThreadMcpConnectionsRequest,
  ): Promise<SetThreadMcpConnectionsResponse> {
    return this.threadMcpConnections.setThreadMcpConnections(request);
  }

  setThreadModelSettings(params: SetThreadModelSettingsRequest): Promise<SetThreadModelSettingsResponse> {
    return this.threadModelSettings.setThreadModelSettings(params);
  }

  applyThreadModelMigration(params: ApplyThreadModelMigrationRequest): Promise<ApplyThreadModelMigrationResponse> {
    return this.threadModelSettings.applyThreadModelMigration(params);
  }

  /**
   * Locks, re-notes or unlocks a thread. Every lock write lands here (the
   * sidebar menu, the thread's lock card, the `mutate_thread` agent tool and
   * a peer), so windows, messaging status surfaces and federation viewers
   * all hear one `thread/lock/updated` event. Changing the note of a locked
   * thread keeps its original time and source. The lock itself is enforced
   * by `assertThreadNotLocked`.
   */
  async setThreadLock(
    request: {
      backend: AppServerBackendKind;
      threadId: string;
      locked: boolean;
      note?: string;
    },
    origin: { source: ThreadLockSource; sourceInstanceId?: FederationInstanceId },
    /** False leaves a queue the lock held for the caller to resume. */
    options: { resumeQueue?: boolean } = {},
  ): Promise<SetThreadLockResponse> {
    const identity = { backend: request.backend, threadId: request.threadId };
    const current = await this.readThreadLock(request.backend, request.threadId);
    let lock: ThreadLock | undefined;
    if (request.locked) {
      const note = request.note === undefined
        ? current?.note
        : normalizeThreadLockNote(request.note);
      lock = {
        ...(note ? { note } : {}),
        lockedAt: current?.lockedAt ?? Date.now(),
        source: current?.source ?? origin.source,
        ...(current
          ? current.sourceInstanceId ? { sourceInstanceId: current.sourceInstanceId } : {}
          : origin.sourceInstanceId ? { sourceInstanceId: origin.sourceInstanceId } : {}),
      };
      if (current && current.note === lock.note) {
        return { ...identity, lock: current };
      }
    } else if (!current) {
      return identity;
    }
    await this.writeThreadLock(identity, lock);
    if (!lock && options.resumeQueue !== false) {
      // An unlock resumes what the lock paused: a queue the lock held, with
      // its entries in order, drains once the thread is idle.
      await this.threadTurnQueue.releaseHold(identity, isThreadLockRefusal);
    }
    return {
      ...identity,
      ...(lock ? { lock } : { previousLock: current }),
    };
  }

  /** Stores a lock as given, or clears it, and publishes the change. */
  private async writeThreadLock(
    identity: { backend: AppServerBackendKind; threadId: string },
    lock: ThreadLock | undefined,
  ): Promise<void> {
    await this.overlayStore.setThreadLock({ ...identity, lock });
    await this.emit({
      backend: identity.backend,
      notification: {
        method: "thread/lock/updated",
        params: {
          threadId: identity.threadId,
          ...(lock ? { lock } : {}),
        },
      },
    });
    await this.threadPrAutoDispatchHandler?.lockChanged?.({ ...identity, locked: Boolean(lock) });
  }

  async setThreadPrAutoDispatch(
    params: SetThreadPrAutoDispatchRequest,
  ): Promise<SetThreadPrAutoDispatchResponse> {
    await this.setThreadPrAutoDispatchBatch([params]);
    return params;
  }

  /**
   * Apply several operator-initiated Auto-fix preferences before asking the
   * PR coordinator to evaluate them. This prevents a bulk settings action
   * from refreshing or scheduling the same attached PR once per thread.
   */
  async setThreadPrAutoDispatchBatch(
    requests: SetThreadPrAutoDispatchRequest[],
  ): Promise<void> {
    if (requests.length === 0) {
      return;
    }

    // The coordinator resets a thread's repair attempts only when Auto-fix
    // turns on, so each change carries the value it replaced.
    const changes: ThreadPrAutoDispatchPreferenceChange[] = [];
    for (const request of requests) {
      const identity = { backend: request.backend, threadId: request.threadId };
      const previous = await this.overlayStore.getThreadOverlayState(identity);
      await this.overlayStore.setThreadPrAutoDispatchEnabled({
        ...identity,
        enabled: request.enabled,
      });
      changes.push({
        ...identity,
        enabled: request.enabled,
        previouslyEnabled: previous?.prAutoDispatchEnabled === true,
      });
      await this.emit({
        backend: request.backend,
        notification: {
          method: "thread/prAutoDispatch/updated",
          params: {
            threadId: request.threadId,
            enabled: request.enabled,
          },
        },
      });
    }

    if (changes.length === 1) {
      await this.threadPrAutoDispatchHandler?.preferenceChanged(changes[0]!);
      return;
    }
    if (this.threadPrAutoDispatchHandler?.preferencesChanged) {
      await this.threadPrAutoDispatchHandler.preferencesChanged(changes);
      return;
    }
    for (const change of changes) {
      await this.threadPrAutoDispatchHandler?.preferenceChanged(change);
    }
  }

  async cancelThreadPrAutoDispatch(
    params: CancelThreadPrAutoDispatchRequest,
  ): Promise<CancelThreadPrAutoDispatchResponse> {
    const cancelled =
      await this.threadPrAutoDispatchHandler?.cancelPending(params)
      ?? false;
    return { ...params, cancelled };
  }

  async sendThreadPrAutoDispatchNow(
    params: SendThreadPrAutoDispatchNowRequest,
  ): Promise<SendThreadPrAutoDispatchNowResponse> {
    const accepted =
      await this.threadPrAutoDispatchHandler?.sendPendingNow(params)
      ?? false;
    return { ...params, accepted };
  }

  async turnOffCodexFastEverywhere(): Promise<TurnOffCodexFastEverywhereResponse> {
    const result = await this.overlayStore.turnOffCodexFastEverywhere();
    for (const threadId of result.updatedThreadIds) {
      await this.emit({
        backend: "codex",
        notification: {
          method: "thread/modelSettings/updated",
          params: {
            threadId,
            fastMode: false,
            serviceTier: undefined,
          },
        },
      });
    }
    return {
      launchpadCount: result.launchpadCount,
      threadCount: result.threadCount,
    };
  }

  async checkThreadBranchDrift(
    params: CheckThreadBranchDriftRequest,
  ): Promise<CheckThreadBranchDriftResponse> {
    if (this.closed) {
      return {
        backend: params.backend,
        threadId: params.threadId,
        drifted: false,
        checkedAt: Date.now(),
      };
    }
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    if (this.closed) {
      return {
        backend: params.backend,
        threadId: params.threadId,
        drifted: false,
        checkedAt: Date.now(),
      };
    }
    const thread = await this.findThreadForWorkspaceHandoff({
      backend: params.backend,
      callerReason: "branch-drift",
      freshness: "last-known",
      threadId: params.threadId,
    });
    const workspaceCwd = resolveThreadWorkspaceCwd(
      thread,
      overlay?.extraLinkedDirectories ?? [],
    );
    const observedBranch = workspaceCwd
      ? await readCurrentGitBranch(workspaceCwd).catch(() => thread?.observedGitBranch)
      : thread?.observedGitBranch;
    const normalizedObservedBranch = observedBranch?.trim() || undefined;
    const expectedBranchResolution = resolveBranchDriftExpectedBranch({
      // Claude and ACP have no provider-owned Git branch to preserve. Repair
      // a detached placeholder even when no workspace handoff was recorded.
      providerOwnsBranchMetadata: params.backend === "codex",
      observedBranch: normalizedObservedBranch,
      overlay,
      requestedExpectedBranch: params.expectedBranch,
      thread,
    });
    const expectedBranch = expectedBranchResolution.expectedBranch;

    const drifted = isBranchDrifted(expectedBranch, normalizedObservedBranch);

    if (this.closed) {
      return {
        backend: params.backend,
        threadId: params.threadId,
        expectedBranch,
        observedBranch: normalizedObservedBranch,
        drifted,
        checkedAt: Date.now(),
      };
    }

    const expectedBranchToPersist =
      drifted || expectedBranchResolution.repairedDetachedHandoffBranch
        ? expectedBranch
        : undefined;
    const observationChanged = !overlay
      || overlay.observedGitBranch !== normalizedObservedBranch
      || (expectedBranchToPersist !== undefined
        && (!overlay.gitBranch?.trim() || expectedBranchToPersist === normalizedObservedBranch)
        && overlay.gitBranch !== expectedBranchToPersist);
    const persistedOverlay = observationChanged ? await this.overlayStore.setThreadObservedBranch({
      backend: params.backend,
      threadId: params.threadId,
      branch: normalizedObservedBranch,
      expectedBranch: expectedBranchToPersist,
    }) : await this.overlayStore.getThreadOverlayState(params);
    const persistedExpectedBranch = persistedOverlay?.gitBranch?.trim() || undefined;
    const effectiveExpectedBranch = persistedExpectedBranch ?? expectedBranch;
    const effectiveDrifted = isBranchDrifted(
      effectiveExpectedBranch,
      normalizedObservedBranch,
    );

    if (
      expectedBranchResolution.repairedDetachedHandoffBranch &&
      expectedBranch &&
      effectiveExpectedBranch === expectedBranch
    ) {
      await this.updateThreadGitBranchMetadata({
        backend: params.backend,
        threadId: params.threadId,
        branch: expectedBranch,
      });
      await this.emit({
        backend: params.backend,
        notification: {
          method: "thread/branch/updated",
          params: {
            threadId: params.threadId,
            branch: expectedBranch,
          },
        },
      } as unknown as AgentEvent);
    }

    if (effectiveDrifted) {
      backendRegistryLog.debug("checked thread branch drift", {
        backend: params.backend,
        drifted: effectiveDrifted,
        expectedBranch: effectiveExpectedBranch,
        observedBranch: normalizedObservedBranch,
        workspaceCwd,
        threadId: params.threadId,
      });
    }

    return {
      backend: params.backend,
      threadId: params.threadId,
      expectedBranch: effectiveExpectedBranch,
      observedBranch: normalizedObservedBranch,
      drifted: effectiveDrifted,
      checkedAt: Date.now(),
    };
  }

  private async adoptThreadBranchChangeFromActiveTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    // Branch metadata must not hold a terminal event past the quit deadline.
    if (this.stoppingRunningTurnsForShutdown) return;
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    const thread = await this.findThreadForWorkspaceHandoff({
      backend: params.backend,
      callerReason: "active-turn-branch-adoption",
      freshness: "last-known",
      threadId: params.threadId,
    });
    if (this.stoppingRunningTurnsForShutdown) return;
    const workspaceCwd = resolveThreadWorkspaceCwd(
      thread,
      overlay?.extraLinkedDirectories ?? [],
    );
    const observedBranch = workspaceCwd
      ? await readCurrentGitBranch(workspaceCwd, this.activeTurnBranchProbeAbort.signal).catch(() => thread?.observedGitBranch)
      : thread?.observedGitBranch;
    if (this.stoppingRunningTurnsForShutdown) return;
    const normalizedObservedBranch = observedBranch?.trim() || undefined;

    if (!normalizedObservedBranch) {
      return;
    }

    if (normalizedObservedBranch === "HEAD") {
      if (overlay?.observedGitBranch !== normalizedObservedBranch) {
        await this.overlayStore.setThreadObservedBranch({
          backend: params.backend,
          threadId: params.threadId,
          branch: normalizedObservedBranch,
        });
      }
      return;
    }

    const previousExpectedBranch = resolveExpectedThreadBranch({
      overlay,
      thread,
    });
    if (overlay?.gitBranch === normalizedObservedBranch
      && overlay.observedGitBranch === normalizedObservedBranch) {
      return;
    }
    await this.overlayStore.setThreadExpectedBranch({
      backend: params.backend,
      threadId: params.threadId,
      branch: normalizedObservedBranch,
    });
    await this.updateThreadGitBranchMetadata({
      backend: params.backend,
      threadId: params.threadId,
      branch: normalizedObservedBranch,
    });
    if (previousExpectedBranch !== normalizedObservedBranch) {
      await this.emit({
        backend: params.backend,
        notification: {
          method: "thread/branch/updated",
          params: {
            threadId: params.threadId,
            branch: normalizedObservedBranch,
          },
        },
      } as unknown as AgentEvent);
    }

    if (previousExpectedBranch !== normalizedObservedBranch) {
      backendRegistryLog.info("adopted active-turn branch change", {
        backend: params.backend,
        observedBranch: normalizedObservedBranch,
        previousExpectedBranch,
        workspaceCwd,
        threadId: params.threadId,
      });
    }
  }

  async updateThreadExpectedBranch(
    params: UpdateThreadExpectedBranchRequest,
  ): Promise<UpdateThreadExpectedBranchResponse> {
    const branch = params.branch.trim();
    if (!branch) {
      throw new Error("Expected branch cannot be blank.");
    }

    await this.overlayStore.setThreadExpectedBranch({
      backend: params.backend,
      threadId: params.threadId,
      branch,
    });
    await this.updateThreadGitBranchMetadata({
      backend: params.backend,
      threadId: params.threadId,
      branch,
    });
    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/branch/updated",
        params: {
          threadId: params.threadId,
          branch,
        },
      },
    } as unknown as AgentEvent);

    backendRegistryLog.info("updated thread expected branch", {
      backend: params.backend,
      branch,
      threadId: params.threadId,
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      branch,
      updatedAt: Date.now(),
    };
  }

  async retainThreadBranchDrift(
    params: RetainThreadBranchDriftRequest,
  ): Promise<RetainThreadBranchDriftResponse> {
    const retainedAt = Date.now();
    // R14: refuse to persist (HEAD, *) pairs. Each "first named branch
    // after detached HEAD" is a meaningful new context that should
    // re-prompt the user, not be permanently silenced.
    if (params.expectedBranch !== "HEAD") {
      await this.overlayStore.retainThreadBranchDrift({
        backend: params.backend,
        threadId: params.threadId,
        expectedBranch: params.expectedBranch,
        observedBranch: params.observedBranch,
        retainedAt,
      });
    }

    return {
      ...params,
      retainedAt,
    };
  }

  async submitServerRequest(
    params: SubmitServerRequestRequest
  ): Promise<SubmitServerRequestResponse> {
    this.assertNotBootstrap("submitServerRequest");
    const key = buildPendingRequestKey(params);
    const pending = this.pendingServerRequests.get(key);
    if (!pending) {
      throw new Error(`No pending server request found for ${params.requestId}`);
    }
    const answeredLatestRequest =
      this.getPendingRequestForThread(params)?.params.requestId === params.requestId;

    const recordedQuestionnaire =
      pending.notification.method === "item/tool/requestUserInput"
        ? await this.recordQuestionnaireActivity({
            backend: params.backend,
            notification:
              pending.notification as AppServerToolRequestUserInputNotification,
            response: params.response,
          })
        : false;
    this.pendingServerRequests.delete(key);
    // Capture the request already hidden by this card before resolving the
    // provider call. Resolution can immediately create and publish a new
    // request, which must not be emitted a second time here.
    const remainingRequest = answeredLatestRequest
      ? this.getPendingRequestForThread(params)
      : undefined;
    pending.resolve(params.response);
    await this.emit({
      backend: params.backend,
      notification: {
        method: "serverRequest/resolved",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          requestId: params.requestId,
        },
      },
    });
    // Several tools can ask for input concurrently, while the transcript has
    // one interaction card. Restore the remaining request after removing the
    // answered card so it stays actionable without leaving the thread.
    if (remainingRequest && this.getPendingRequestForThread(params) === remainingRequest) {
      await this.emit({ backend: params.backend, notification: remainingRequest });
    }
    if (recordedQuestionnaire) {
      await this.emit({
        backend: params.backend,
        notification: {
          method: "thread/questionnaireActivity/updated",
          params: {
            threadId: params.threadId,
            requestId: params.requestId,
          },
        },
      });
    }

    return {
      backend: params.backend,
      threadId: params.threadId,
      turnId: params.turnId,
      requestId: params.requestId,
    };
  }

  /** Compact navigation signal only; never expose pending prompts or response options. */
  getNavigationInputRequestThreadKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const pending of this.pendingServerRequests.values()) {
      keys.add(buildThreadIdentityKey(pending.backend, pending.notification.params.threadId));
    }
    return keys;
  }

  /** Every pending server request, for the operator's request list. */
  listPendingServerRequests(): Array<{
    backend: AppServerBackendKind;
    notification: AppServerPendingRequestNotification;
  }> {
    return [...this.pendingServerRequests.values()].map((pending) => ({
      backend: pending.backend,
      notification: pending.notification,
    }));
  }

  getPendingRequestForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): AppServerPendingRequestNotification | undefined {
    let pendingRequest: AppServerPendingRequestNotification | undefined;
    for (const pending of this.pendingServerRequests.values()) {
      if (
        pending.backend === params.backend
        && pending.notification.params.threadId === params.threadId
      ) {
        pendingRequest = pending.notification;
      }
    }
    return pendingRequest;
  }

  ensureDirectoryLaunchpad(
    request: EnsureDirectoryLaunchpadRequest,
    options?: {
      /**
       * A remote viewer may persist the draft here, but its matching local path
       * is never a valid source of environment/filesystem metadata.
       */
      skipFilesystemInspection?: boolean;
      /**
       * The same viewer's draft must not take this machine's MCP defaults
       * either. Connection ids are per machine and the two built-ins share
       * theirs everywhere, so a local "PwrSnap for new threads" would select
       * the *remote* machine's PwrSnap on a thread the operator never chose
       * it for there.
       */
      skipMcpConnectionDefaults?: boolean;
      /**
       * The instance that owns `directoryKey`. A peer's draft is stored under
       * a key that names the peer (`launchpadStorageKey`), so it never shares
       * a row with this machine's draft for the same key. The response keeps
       * the owner's key.
       */
      owner?: FederationTarget;
    },
  ): Promise<EnsureDirectoryLaunchpadResponse> {
    const response = this.threadDirectoryService.ensureDirectoryLaunchpad(request, options);
    if (this.codexOpenAiProviderEnabled || options?.owner?.scope === "remote") return response;
    return response.then(({ launchpad, defaults }) => ({
      launchpad: this.projectOutpostLaunchpadSettings(launchpad),
      defaults: this.projectOutpostLaunchpadSettings(defaults),
    }));
  }

  updateDirectoryLaunchpad(
    request: UpdateDirectoryLaunchpadRequest,
    options?: {
      /** A remote viewer's draft takes no environment metadata from here. */
      skipFilesystemInspection?: boolean;
      /** Leave the stored draft as it is unless this holds for it. */
      onlyIf?: (current: NavigationLaunchpadDraft) => boolean;
      /** The instance that owns `directoryKey`, as on an ensure. */
      owner?: FederationTarget;
    },
  ): Promise<UpdateDirectoryLaunchpadResponse> {
    return this.threadDirectoryService.updateDirectoryLaunchpad(request, options);
  }

  resetDirectoryLaunchpad(
    request: ResetDirectoryLaunchpadRequest,
    options?: {
      /** The instance that owns `directoryKey`, as on an ensure. */
      owner?: FederationTarget;
    },
  ): Promise<ResetDirectoryLaunchpadResponse> {
    return this.threadDirectoryService.resetDirectoryLaunchpad(request, options);
  }

  runCodexEnvironmentAction(
    request: RunCodexEnvironmentActionRequest,
  ): Promise<RunCodexEnvironmentActionResponse> {
    return this.threadDirectoryService.runCodexEnvironmentAction(request);
  }

  /**
   * The backend tasks a thread waits on, for Waiting For. Only Claude takes
   * another turn when one ends, and its sub-agents count: the Actions list
   * leaves them out because they have Sub-agents cards.
   */
  listBackendTaskWakes(thread: { backend: AppServerBackendKind; threadId: string }): AppServerBackgroundTask[] {
    return thread.backend === "claude" ? this.claudeBackend.listWaitingTasks(thread.threadId) : [];
  }

  listBackgroundTerminals(request: ListBackgroundTerminalsRequest): Promise<ListBackgroundTerminalsResponse> {
    return this.codexRuntimeSupervisor.listBackgroundTerminals(request);
  }

  terminateBackgroundTerminal(request: TerminateBackgroundTerminalRequest): Promise<TerminateBackgroundTerminalResponse> {
    return this.codexRuntimeSupervisor.terminateBackgroundTerminal(request);
  }

  stopCodexEnvironmentAction(
    request: StopCodexEnvironmentActionRequest,
  ): Promise<StopCodexEnvironmentActionResponse> {
    return this.threadDirectoryService.stopCodexEnvironmentAction(request);
  }

  setCodexThreadEnvironment(
    request: SetCodexThreadEnvironmentRequest,
    onSetupProgress?: (event: CodexEnvironmentSetupProgressEvent) => void,
  ): Promise<SetCodexThreadEnvironmentResponse> {
    return this.threadDirectoryService.setCodexThreadEnvironment(request, onSetupProgress);
  }

  materializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
    options?: MaterializeDirectoryLaunchpadOptions & {
      sourceInstanceId?: FederationInstanceId;
      turnInputSource?: TurnInputSource;
    },
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    return this.threadDirectoryService.materializeDirectoryLaunchpad(request, options);
  }

  manageLaunchpadCreation(
    request: LaunchpadCreationRequest,
    sourceInstanceId?: FederationInstanceId,
  ): Promise<LaunchpadCreationResponse> {
    return this.threadDirectoryService.manageLaunchpadCreation(request, sourceInstanceId);
  }

  acknowledgeThreadEnvironmentFailure(
    request: AcknowledgeThreadEnvironmentFailureRequest,
  ): Promise<AcknowledgeThreadEnvironmentFailureResponse> {
    return this.threadDirectoryService.acknowledgeThreadEnvironmentFailure(request);
  }

  continueThreadEnvironmentStartup(
    request: ContinueThreadEnvironmentStartupRequest,
    fallbackInputSource?: TurnInputSource,
  ): Promise<ContinueThreadEnvironmentStartupResponse> {
    return this.threadDirectoryService.continueThreadEnvironmentStartup(request, fallbackInputSource);
  }

  async markScheduledThreadBorn(params: {
    actionId: string;
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    const current = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    if (current?.scheduledStart?.actionId !== params.actionId) {
      return;
    }
    await this.overlayStore.setThreadScheduledStart({
      backend: params.backend,
      threadId: params.threadId,
      scheduledStart: undefined,
    });
    this.invalidateThreadListCache(params.backend);
  }

  async markScheduledThreadStartTerminal(params: {
    actionId: string;
    backend: AppServerBackendKind;
    state: "cancelled" | "failed";
    threadId: string;
  }): Promise<void> {
    const current = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    if (current?.scheduledStart?.actionId !== params.actionId) {
      return;
    }
    await this.overlayStore.setThreadScheduledStart({
      backend: params.backend,
      threadId: params.threadId,
      scheduledStart: {
        ...current.scheduledStart,
        state: params.state,
      },
    });
    this.invalidateThreadListCache(params.backend);
  }

  async updateScheduledThreadStartTime(params: {
    actionId: string;
    backend: AppServerBackendKind;
    scheduledFor: number;
    threadId: string;
  }): Promise<void> {
    const current = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    if (
      current?.scheduledStart?.actionId !== params.actionId
      || current.scheduledStart.state !== "scheduled"
    ) {
      return;
    }
    await this.overlayStore.setThreadScheduledStart({
      backend: params.backend,
      threadId: params.threadId,
      scheduledStart: {
        ...current.scheduledStart,
        scheduledFor: params.scheduledFor,
      },
    });
    this.invalidateThreadListCache(params.backend);
  }

  close(): Promise<void> {
    this.shutdownRequested = true;
    this.codexProviderCatalogRetry.close();
    this.threadDirectoryService.cancelLaunchpadCreations();
    for (const timer of this.restartGateTimers) clearTimeout(timer);
    this.restartGateTimers.clear();
    this.closeOperation ??= this.closeResources();
    return this.closeOperation;
  }

  /** Reserve the profile owner before a durable wake is claimed. */
  tryAcquireThreadOwnership(): boolean {
    try {
      this.assertThreadOwnership();
      return true;
    } catch {
      return false;
    }
  }

  private assertThreadOwnership(): void {
    if (this.closed || this.shutdownRequested) throw new Error("Desktop backend registry is closed");
    this.ownerAdmission?.assertOwnership();
  }

  private async closeResources(): Promise<void> {
    this.threadArchiveCoordinator.tryCheckpointArchiveCleanupsForQuit("before-drain");
    // Drain terminal delivery before closing resources. The quit phase
    // normally does this while messaging is still running. With no pending
    // work, `closed` below must hold from the call itself.
    const runningTurnsStopPending = this.runningTurnsShutdownStop
      ? !this.runningTurnsShutdownStopSettled
      : this.hasTurnShutdownWork(this.context.turnState.registeredTurnCount);
    if (runningTurnsStopPending) {
      await this.stopRunningTurnsForShutdown();
    }
    this.mcpGatewayTools?.cancel();
    this.threadMcpConnections.clearSessionApprovals();
    this.headlessAutomation.revokeRegistrations();
    this.closed = true;
    await Promise.all(this.transcriptRepairs.values());
    this.threadDirectoryService.flushCodexEnvironmentActionLiveOutputsForShutdown();
    this.threadTurnQueue.close();
    this.queuedMessageTitler.close();
    for (const key of [...this.threadArchiveCoordinator.archiveCleanupOverflowRecords.keys()]) this.threadArchiveCoordinator.cancelArchiveCleanupOverflow(key);
    await this.threadArchiveCoordinator.closeArchiveCleanupQueue();
    this.threadArchiveCoordinator.tryCheckpointArchiveCleanupsForQuit("after-drain");
    this.codexRuntimeSupervisor.clearBackgroundTerminalsForShutdown();
    await this.threadArchiveCoordinator.stopThreadArchiveSweeper();
    this.threadArchiveCoordinator.invalidateArchiveCleanupReads();
    // A recovery drain waiting for other Codex turns gives up now; the final
    // Codex close below still waits for that drain before it runs.
    this.codexRuntimeSupervisor.abortInvalidIdRecoveriesForShutdown();
    // `closed` rejects observations that enter from this point forward. The
    // snapshot was registered synchronously at each earlier usage emit's
    // entry, so waiting it cannot miss work still deriving its sqlite row.
    const liveThreadUsageEmitBarrier =
      this.threadUsageLedger.waitForLiveThreadUsageEmitWork();
    this.threadSteering.clear();
    this.acceptedThreadControlRequests.clear();
    this.acceptedHandoffTaskRequests.clear();
    this.acceptedDynamicToolCalls.clear();
    this.acceptedActiveTurnControlRequests.clear();
    // A background working-state round outlives the snapshot that scheduled
    // it. `closed` stops a new one, and draining the live ones here keeps the
    // clears below final: `rememberThreadGitWorkingStateCacheEntry` reloads
    // the durable cache, so a late round would refill the map and write to a
    // store that is on its way out.
    if (this.threadGitWorkingStateRefreshRound) {
      await this.threadGitWorkingStateRefreshRound;
    }
    await Promise.all([...this.focusedThreadGitWorkingStateRefreshes]);
    this.workingStateByWorktree.clear();
    this.workingStateCacheLoad = undefined;
    if (this.taskMonitorWatchdogTimer) {
      clearInterval(this.taskMonitorWatchdogTimer);
    }
    if (this.acpIdleSessionTimer) {
      clearInterval(this.acpIdleSessionTimer);
      this.acpIdleSessionTimer = undefined;
    }
    this.codexRuntimeSupervisor.stopAppServerRecycler();
    this.codexRuntimeSupervisor.stopIdleThreadUnsubscriber();
    if (this.missingCodexThreadEvaluationTimer) {
      clearTimeout(this.missingCodexThreadEvaluationTimer);
      this.missingCodexThreadEvaluationTimer = undefined;
    }
    if (this.codexRateLimitBroadcastTimer) {
      clearTimeout(this.codexRateLimitBroadcastTimer);
      this.codexRateLimitBroadcastTimer = undefined;
    }
    this.pendingCodexRateLimitBroadcast = undefined;
    await this.missingCodexThreadEvaluation;
    // Live usage and command output may each have one bounded window sitting
    // in memory. `closed` prevents either drain from re-arming its timer; the
    // serialized flush chains ensure no write survives close().
    await liveThreadUsageEmitBarrier;
    await this.threadUsageLedger.currentTokenMiserLedgerReconciliation;
    this.subAgentMonitorService.clearCompletedTaskMonitors();
    await this.threadUsageLedger.flushLiveThreadUsageLines();
    await this.subAgentMonitorService.persistLiveCodexNativeSubAgentUsage();
    await this.usageTurnStartupRepair;
    await this.threadUsageLedger.completeRunningThreadUsageTurnsAtShutdown();
    // A command streaming at quit time has accounting worth up to one flush
    // window sitting in memory; write it before the store goes away. The flush
    // owns the timer, and `closed` above stops anything re-arming it.
    await this.threadUsageLedger.flushStreamedToolInvocationDeltas();
    this.subAgentMonitorService.cancelCodexNativeSubAgentReconciliations();
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.streamNoticeOwners.clear();
    this.planLimits.close();

    for (const [key, pending] of this.pendingServerRequests) {
      pending.reject(new Error(`Desktop backend registry closed before ${key} resolved`));
      this.pendingServerRequests.delete(key);
    }

    this.codexRuntimeSupervisor.rejectPendingInvalidIdRecoveriesForShutdown();
    const recoveryDrain = this.codexRuntimeSupervisor.invalidIdRecoveryDrain;
    const resources = [
      { name: "acp", close: () => this.acpBackend.close() },
      { name: "claude", close: () => this.claudeBackend.close() },
      {
        name: "codex-protocol-capture",
        close: () => this.codexProtocolCaptureSession?.close(),
      },
      { name: "pdf-mcp", close: () => this.pdfToolMcpServer?.close() },
      {
        name: "token-miser-hook-bridge",
        close: () => this.tokenMiserHookBridge?.close(),
      },
      {
        name: "codex",
        close: async () => {
          try {
            await recoveryDrain;
          } finally {
            // Recovery may restart the transport before it observes that the
            // registry closed. Always make the final Codex close happen after
            // that drain so no retry-path child can escape shutdown.
            await this.codexClient.close();
          }
        },
      },
      ...this.captureStores.splice(0).map((store, index) => ({
        name: `capture-${index}`,
        close: () => store.close(),
      })),
    ];
    const results = await Promise.allSettled(
      resources.map((resource) => Promise.resolve().then(resource.close)),
    );
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [{ name: resources[index].name, reason: result.reason }]
        : [],
    );
    // Producers are now closed and previously admitted observations drained.
    await this.tokenMiserDiagnostics?.close();
    // Preserve active-turn estimates even when another resource failed close.
    try {
      await this.tokenMiserStore?.flushAll();
    } catch (error) {
      failures.push({ name: "token-miser-replay", reason: error });
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Desktop backend registry close failed: ${failures
          .map((failure) => failure.name)
          .join(", ")}`,
      );
    }
    await this.agentMemory.drainMutations();
    this.ownerAdmission?.close();
  }

  private async admitNewThreadModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings & { acpRuntime?: BackendAcpSessionRuntimeState },
  ): Promise<ModelSettings> {
    if (!isAppServerBackendKind(backend)) {
      throw new Error(`backend="${backend}" is not available.`);
    }
    const capabilities = isAcpBackendId(backend)
      ? this.acpBackend.getInstalledAgent(backend)?.runtimeCapabilities
      : undefined;
    const modelOption = findAcpModelConfigOption(capabilities);
    const effortOption = findAcpThoughtLevelConfigOption(capabilities);
    const runtimeEffort = (effortOption ? settings.acpRuntime?.configValues?.[effortOption.id] : undefined)
      ?? settings.acpRuntime?.reasoningEffort;
    // A single advertised thought level is fixed runtime state, not an
    // adjustable reasoning override. Preserve it in acpRuntime; explicit
    // overrides and values outside that menu still require admission.
    const fixedRuntimeEffort = effortOption?.values.length === 1
      && effortOption.values[0]?.value === runtimeEffort;
    const requested = {
      ...settings,
      model: settings.model
        ?? (modelOption ? settings.acpRuntime?.configValues?.[modelOption.id] : undefined)
        ?? settings.acpRuntime?.currentModelId,
      reasoningEffort: settings.reasoningEffort
        ?? (fixedRuntimeEffort ? undefined : runtimeEffort),
    };
    assertOwnerCodexModelSelection(getOwnerHostServices().runtimePolicy, { backend, model: requested.model });
    const options = await this.getBackendLaunchpadOptions(backend, "thread-admission");
    const resolved = resolveModelSettingsFromOptions(backend, options, this.withOutpostLaunchModel(backend, options, requested));
    assertThreadModelSettingsAvailable(backend, options, requested, resolved.model);
    if (backend === "codex" && !this.codexOpenAiProviderEnabled && !resolved.model) {
      throw new Error("No configured Codex model is available on this Outpost.");
    }
    return this.applyCodexFastPolicy(backend, resolved);
  }

  private async resolveModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings,
    callerReason: BackendModelCatalogCallerReason = "thread-start-defaults",
  ): Promise<ModelSettings> {
    // Preserve OpenAI settings when reading a stored draft or thread. The
    // proxy substitution belongs to launch admission and view projection.
    if (backend === "codex" && !this.codexOpenAiProviderEnabled
      && navigationLaunchpadProviderKey({ backend, ...settings }) === "codex") return settings;
    const options = await this.getBackendLaunchpadOptions(backend, callerReason);
    const resolved = resolveModelSettingsFromOptions(backend, options, settings);
    return this.applyCodexFastPolicy(backend, resolved);
  }

  private get codexOpenAiProviderEnabled(): boolean {
    return getOwnerHostServices().runtimePolicy?.codexOpenAiProviderEnabled !== false;
  }

  private withOutpostLaunchModel(backend: AppServerBackendKind, options: BackendLaunchpadOptions | undefined, settings: ModelSettings): ModelSettings {
    if (backend !== "codex" || this.codexOpenAiProviderEnabled || settings.codexModelProviderId
      || (settings.model && parseCodexProviderModelId(settings.model).providerId)) return settings;
    const unavailable = new Set(this.codexModelProviderCatalog?.catalogStates()
      .filter((state) => state.status === "unavailable").map((state) => state.id));
    const customModels = (options?.models ?? []).filter((model) => model.providerId);
    const preferredModels = customModels.filter((model) => model.providerId && !unavailable.has(model.providerId));
    // A failed /models read still offers the operator's explicitly listed models.
    const model = getDefaultModelOption("codex", { ...options, models: preferredModels.length ? preferredModels : customModels });
    if (!model?.providerId) return { ...settings, model: undefined };
    const key = codexModelProviderPickerValue(model.providerId);
    const configured = this.resolveProviderModelDefaultsFn()[key];
    const preferred = settings.providerSettings?.[key]?.model ?? configured?.model;
    const preferredModel = options?.models?.find((option) => option.id === preferred && option.providerId === model.providerId);
    return { ...settings, model: preferredModel?.id ?? model.id };
  }

  /** Project current launch choices without saving over the operator's stored presets. */
  projectOutpostLaunchpadSettings<T extends NavigationLaunchpadDefaults>(settings: T, options?: BackendLaunchpadOptions): T {
    const policy = getOwnerHostServices().runtimePolicy;
    if (policy?.codexOpenAiProviderEnabled !== false || settings.backend !== "codex" || navigationLaunchpadProviderKey(settings) !== "codex") return settings;
    const launchpadOptions = options ?? this.readCodexBackendSummary().launchpadOptions;
    const choice = this.withOutpostLaunchModel("codex", launchpadOptions, { providerSettings: settings.providerSettings });
    const providerId = choice.model ? parseCodexProviderModelId(choice.model).providerId : undefined;
    if (!providerId) {
      const providerSettings = { ...settings.providerSettings };
      delete providerSettings.codex;
      return { ...settings, providerSettings, model: undefined, reasoningEffort: undefined, serviceTier: undefined, fastMode: undefined };
    }
    const key = codexModelProviderPickerValue(providerId);
    const savedMode = settings.providerSettings?.[key]?.executionMode;
    const preferredMode = savedMode ?? resolveDefaultLaunchpadExecutionMode(key, this.resolveProviderModelDefaultsFn());
    const executionMode = policy.executionModes.includes(preferredMode) ? preferredMode : policy.executionModes[0] ?? "default";
    const resolved = this.applyCodexFastPolicy("codex", resolveModelSettingsFromOptions("codex", launchpadOptions, choice));
    const projected = applyNavigationLaunchpadProviderSettingsPatch<NavigationLaunchpadDefaults>(
      settings,
      { ...resolved, codexModelProviderId: providerId, executionMode },
    );
    return { ...settings, ...projected };
  }

  /** Check provider ownership before accepting input or reserving work on a retained thread. */
  async assertThreadCodexInferenceAvailable(params: Pick<OwnerExecutionRequest, "backend" | "model" | "collaborationMode"> & { threadId: string }): Promise<void> {
    if (params.backend !== "codex" || this.codexOpenAiProviderEnabled) return;
    assertOwnerCodexModelSelection(getOwnerHostServices().runtimePolicy, params);
    if (!this.codexClient.modelProviderForThread?.(params.threadId)
      && !this.codexClient.reportedModelProviderForThread?.(params.threadId)) {
      await this.codexClient.readThreadSummary?.(params.threadId);
    }
    const providerId = this.codexClient.modelProviderForThread?.(params.threadId)
      ?? this.codexClient.reportedModelProviderForThread?.(params.threadId);
    assertOutpostCodexProvider(providerId);
    if (!this.resolveCodexModelProvidersFn().some((provider) => provider.id === providerId)) {
      throw new Error(`Codex model provider ${providerId} is no longer configured on this Outpost.`);
    }
    const collaborationModel = params.collaborationMode?.settings?.model;
    if (collaborationModel && parseCodexProviderModelId(collaborationModel).providerId !== providerId) {
      throw new Error(`This thread runs on ${providerId}. Choose a model from that provider.`);
    }
  }

  private applyCodexFastPolicy(backend: AppServerBackendKind, resolved: ModelSettings): ModelSettings {
    if (backend !== "codex" || this.resolveCodexFastAllowedFn()) {
      return resolved;
    }
    return {
      ...resolved,
      serviceTier: undefined,
      fastMode: false,
    };
  }

  /**
   * One-shot structured generation as an ephemeral Codex helper turn. The
   * Helper model setting picks the model, and that model is a Codex
   * model, so this runs on Codex whenever Codex is usable regardless of
   * the launchpad default; otherwise it returns "unavailable".
   */
  async generateStructuredObject(params: {
    helper: HelperModelId;
    model?: string;
    reasoningEffort?: string;
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
    schemaName?: string;
    /** Removes shell, exec, and sub-agent tools from a data-only helper. */
    disableExecution?: boolean;
    timeoutMs?: number;
    /** Model answering budget, separate from the protocol round-trips. */
    turnTimeoutMs?: number;
  }): Promise<ThreadTitleAdapterResult> {
    // Helper work must not discover unrelated providers or probe Codex auth.
    // An installed executable can still have a known signed-out account.
    const backend = this.readCodexBackendSummary();
    const requiresLogin = backend.account?.requiresOpenaiAuth === true
      && !backend.account.type;
    const requiredKeys = schemaRequiredKeys(params.schema);

    if (
      !this.closed
      && backend.available
      && !requiresLogin
      && (!this.codexOpenAiProviderEnabled || !this.codexClient.isAuthenticationRequired?.())
      && this.codexClient.generateStructuredObject
    ) {
      return await this.codexClient.generateStructuredObject({
        helper: params.helper,
        system: params.system,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        prompt: params.prompt,
        schema: params.schema,
        ...(params.disableExecution ? { disableExecution: true } : {}),
        isMatch: (record) =>
          requiredKeys.every((key) =>
            structuredRequiredFieldMatches(params.schema, record, key)
          ),
        timeoutMs: params.timeoutMs,
        turnTimeoutMs: params.turnTimeoutMs,
      });
    }

    return {
      status: "unavailable",
      reason: "codex_structured_generation_unavailable",
    };
  }

  /**
   * Run the Star Map `[+]` intake as one ephemeral agent turn.
   *
   * The turn creates the thread itself, through the same
   * `create_instance_thread` an operator's own agent would use, and then
   * dissolves. Nothing persists and nothing is shown: the operator sees the
   * thread they asked for appear, not a relay thread that asked for it.
   *
   * Returns `undefined` when no backend here can run a tool-using turn, which
   * is the caller's signal to fall back to the deterministic resolver.
   */
  async runStarMapIntakeAgentTurn(params: {
    prompt: string;
    system: string;
    resolveDirectoryKey: (projectKey: string) => string | undefined;
    attachments?: AppServerTurnInputItem[];
    onCreateStarting?: (projectKey: string) => void;
    model?: string;
    reasoningEffort?: string;
    timeoutMs?: number;
    turnTimeoutMs?: number;
  }): Promise<
    | { status: "ok"; outcome: StarMapIntakeAgentOutcome | undefined }
    | { status: "failed"; reason: string }
    | undefined
  > {
    // Without the factory every tool the agent could call answers
    // "unavailable", so the turn is bought and guaranteed to produce nothing.
    // Declining here sends the caller straight to the deterministic resolver.
    if (!this.starMapIntakeFederationHandlerFactory
      || (!this.codexOpenAiProviderEnabled && !this.isConfiguredCodexHelperModel(params.model))) {
      return undefined;
    }
    const codex = (await this.listBackends({ includeUnavailable: true })).backends
      .find((summary) => summary.kind === "codex");
    if (!codex?.available || !this.codexClient.runHelperToolTurn) {
      return undefined;
    }
    const tools = buildStarMapIntakeAgentTools({
      federationHandler: this.starMapIntakeFederationHandlerFactory(
        params.attachments ?? [],
      ),
      resolveDirectoryKey: params.resolveDirectoryKey,
      ...(params.onCreateStarting
        ? { onCreateStarting: params.onCreateStarting }
        : {}),
    });
    const result = await this.codexClient.runHelperToolTurn({
      helper: "star_map_intake",
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      system: params.system,
      prompt: params.prompt,
      dynamicTools: tools.dynamicTools,
      onToolCall: tools.handleToolCall,
      timeoutMs: params.timeoutMs,
      turnTimeoutMs: params.turnTimeoutMs,
    });
    // A failed turn can still have created the thread — the tool call
    // succeeds well before the turn ends, and a timeout after that point
    // would otherwise report an intake that worked as one that did not, and
    // send the fallback on to create a second thread.
    const outcome = tools.readOutcome();
    if (result.status === "failed" && !outcome) {
      // A creation that had not answered when the turn ended may still be
      // running: `create_instance_thread` warns that startup "can take
      // minutes", and the federation client alone allows two for it. Reported
      // as a failure this becomes the fallback's cue to create a second
      // thread for the same request, so say what actually happened instead.
      return tools.isCreationInFlight()
        ? { status: "ok", outcome: { kind: "creation_unconfirmed" } }
        : { status: "failed", reason: result.reason };
    }
    return { status: "ok", outcome };
  }

  /** Probe once per client; reducer support is immutable for one app-server. */
  private async readTokenMiserServerCapabilities(
    client: BackendClient,
  ): Promise<CodexServerCapabilities | undefined> {
    const turnCache = this.tokenMiserServerCapabilitiesForTurn.getStore();
    const turnCached = turnCache?.get(client);
    if (turnCached) {
      return await turnCached;
    }
    const cached = this.tokenMiserServerCapabilities.get(client);
    if (cached) {
      turnCache?.set(client, cached);
      return await cached;
    }

    let cacheResult = true;
    const probe = (async () => {
      if (!client.readServerCapabilities) {
        this.tokenMiserReducerCapabilityState = "unsupported";
        this.tokenMiserCodeModeGroupingVersion = undefined;
        this.tokenMiserPostToolUseExactOutputVersion = undefined;
        await this.recordTokenMiserActivation({
          reason: "Codex runtime lacks Token Miser reducer model-guidance v1.",
          state: "unavailable",
        });
        return undefined;
      }
      try {
        const capabilities = await client.readServerCapabilities();
        const reducerCapability = capabilities.codeModeOutputReducer;
        const reducerSupported =
          reducerCapability?.protocolVersion === 1
          && hasTokenMiserModelGuidance(reducerCapability);
        const managedContractRequired =
          this.resolveManagedTokenMiserActivationRequiredFn();
        const managedContractSupported =
          hasManagedTokenMiserCapabilityContract(capabilities);
        const supported =
          reducerSupported
          && (!managedContractRequired || managedContractSupported);
        const unsupportedReason =
          managedContractRequired && !managedContractSupported
            ? TOKEN_MISER_MANAGED_CAPABILITY_REASON
            : "Codex runtime lacks Token Miser reducer model-guidance v1.";
        const grouping = capabilities.codeModeOutputReducer?.postToolUseGrouping;
        this.tokenMiserCodeModeGroupingVersion =
          supported
          && grouping?.version === 1
          && grouping.versionField === "token_miser_grouping_version"
          && grouping.cellIdField === "code_mode_cell_id"
          && grouping.toolCallIdField === "code_mode_tool_call_id"
            ? 1
            : undefined;
        const exactOutput =
          capabilities.codeModeOutputReducer?.postToolUseExactOutput;
        this.tokenMiserPostToolUseExactOutputVersion =
          supported
          && exactOutput?.version === 1
          && exactOutput.versionField
            === "token_miser_exact_tool_response_version"
          && exactOutput.responseField === "token_miser_exact_tool_response"
            ? 1
            : undefined;
        this.tokenMiserReducerCapabilityState = supported
          ? "supported"
          : "unsupported";
        await this.recordTokenMiserActivation(
          supported && !this.tokenMiserRuntimePreparationFailure
            ? { state: "active" }
            : {
                reason:
                  this.tokenMiserRuntimePreparationFailure
                  ?? unsupportedReason,
                state: "unavailable",
              },
        );
        return capabilities;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const normalized = message.toLowerCase();
        const permanentlyUnsupported =
          normalized.includes("method not found")
          || normalized.includes("unknown method")
          || normalized.includes(
            "unknown variant `server/capabilities/read`",
          );
        cacheResult = permanentlyUnsupported;
        if (permanentlyUnsupported) {
          backendRegistryLog.debug(
            "Codex code-mode output reducer capability is unavailable",
            { reason: message },
          );
        } else {
          backendRegistryLog.warn(
            "Codex code-mode output reducer capability probe failed open",
            { error: message },
          );
        }
        this.tokenMiserReducerCapabilityState = permanentlyUnsupported
          ? "unsupported"
          : undefined;
        this.tokenMiserCodeModeGroupingVersion = undefined;
        this.tokenMiserPostToolUseExactOutputVersion = undefined;
        await this.recordTokenMiserActivation({
          reason:
            this.tokenMiserRuntimePreparationFailure
            ?? "Codex runtime lacks Token Miser reducer model-guidance v1.",
          state: "unavailable",
        });
        return undefined;
      }
    })();
    this.tokenMiserServerCapabilities.set(client, probe);
    turnCache?.set(client, probe);
    try {
      return await probe;
    } finally {
      // Capability support is immutable for one live app-server, but a
      // reconnect cancellation says nothing about the replacement process.
      // Remove transient failures from the client-wide cache so the next
      // turn retries. The turn-local cache retains this promise until the
      // current start finishes, keeping its capability-dependent fields
      // consistent and preventing repeated timeout-length probes.
      if (
        !cacheResult
        && this.tokenMiserServerCapabilities.get(client) === probe
      ) {
        this.tokenMiserServerCapabilities.delete(client);
      }
    }
  }

  private async supportsTokenMiserCodeModeReducer(
    client: BackendClient,
  ): Promise<boolean> {
    const capabilities = await this.readTokenMiserServerCapabilities(client);
    if (this.resolveManagedTokenMiserActivationRequiredFn()) {
      return hasManagedTokenMiserCapabilityContract(capabilities);
    }
    return capabilities?.codeModeOutputReducer?.protocolVersion === 1
      && hasTokenMiserModelGuidance(capabilities.codeModeOutputReducer);
  }

  private async supportsTokenMiserDynamicToolsResume(
    client: BackendClient,
  ): Promise<boolean> {
    const capabilities = await this.readTokenMiserServerCapabilities(client);
    return (
      capabilities?.codeModeOutputReducer?.protocolVersion === 1
      && capabilities.codeModeOutputReducer.dynamicToolsResumeField
        === "dynamicTools"
    );
  }

  private async buildSupportedPwrdrvrTokenMiserActivation(params: {
    client: BackendClient;
    enabled: boolean;
  }): Promise<CodexPwrdrvrTokenMiserActivation | null | undefined> {
    // A disabled profile may still have a negotiated connection while another
    // turn keeps the runtime switch pending. Preserve explicit deactivation on
    // that connection; a fresh disabled connection must omit the extension.
    if (
      !this.resolveTokenMiserEnabledFn()
      && !params.client.isTokenMiserActivationNegotiated?.()
    ) return undefined;
    const capabilities = await this.readTokenMiserServerCapabilities(
      params.client,
    );
    if (
      params.client.isTokenMiserActivationNegotiated?.() === false
      || !hasTokenMiserActivationTransport(capabilities)
    ) {
      return undefined;
    }
    if (!params.enabled) {
      return null;
    }
    return hasManagedTokenMiserCapabilityContract(capabilities)
      ? { version: 1, enabled: true }
      : undefined;
  }

  private async buildCodexParentDynamicTools(
    tokenMiserEnabled: boolean,
    discoveryEnabled = this.resolveCodexToolDiscoveryFn(),
    eagerTools?: ReadonlySet<string>,
    caller?: import("@pwragent/shared/contracts/app-tools").PwrAgentAppManagementContext,
  ): Promise<CodexDynamicToolSpec[]> {
    const tools = withPwrAgentToolDiscovery(buildCodexParentDynamicToolSpecs(
      resolveAgentToolCatalogs({
        currentTurnInputSource: this.currentTurnInputSource,
        appManagementAllowed: caller ? await this.canManagePwrAgent(caller, true) : false,
        appManagementHandler: this.appManagementHandler,
        automationInspectionHandler: this.automationInspectionHandler,
        federationHandler: this.federationHandler,
        mcpGatewayTools: this.mcpGatewayTools,
        mcpConnectionHandler: async (request) =>
          await this.threadMcpConnections.handleAgentMcpConnectionRequest(request),
        messagingHandler: this.messagingHandler,
        messagingWorkingUpdatesHandler: this.messagingWorkingUpdatesHandler,
        taskMonitorHandler: async (request) =>
          await this.subAgentMonitorService.handleAgentTaskMonitorRequest(request),
        threadInspectionHandler: this.threadInspectionHandler,
        forgeReadHandler: this.forgeToolBridge.gatedForgeReadHandler,
        forgePrToolHandler: this.forgeToolBridge.gatedForgePrToolHandler,
        forgeToolPolicy: this.forgeToolBridge.resolveForgeToolPolicy(),
        threadOrchestrationHandler: this.threadOrchestrationHandler,
        ...(tokenMiserEnabled ? { tokenMiserStore: this.tokenMiserStore, tokenMiserFocused: this.tokenMiserService?.focused } : {}),
        starMapHandler: this.starMapHandler,
        threadTodoHandler: this.threadTodoHandler,
        openAIDecisionsHandler: this.openAIDecisionsHandler,
        researchHandler: this.advertisedResearchHandler,
        checkoutHandler: this.checkoutHandler,
      }),
    ), discoveryEnabled, eagerTools);
    // Tool search reads this catalog too, so it must not name refused tools.
    const allowlist = localAgentToolAllowlist();
    return allowlist ? filterAdvertisedAgentTools(allowlist, tools) : tools;
  }

  private async buildSupportedCodexDynamicToolsRefresh(params: {
    client: BackendClient;
    threadId: string;
    tokenMiserEnabled: boolean;
  }): Promise<CodexDynamicToolSpec[] | undefined> {
    if (!(await this.supportsTokenMiserDynamicToolsResume(params.client))) {
      return undefined;
    }
    const discoveryEnabled = this.resolveCodexToolDiscoveryFn();
    return this.buildCodexParentDynamicTools(
      params.tokenMiserEnabled,
      discoveryEnabled,
      discoveryEnabled
        ? await this.resolveEagerPwrAgentTools(params.threadId)
        : undefined,
      { backend: "codex", threadId: params.threadId },
    );
  }

  /**
   * A thread whose working set is known loads it eagerly instead of behind
   * tool_search. Resolved on every refresh, so a binding made mid-thread
   * takes effect at the next turn start.
   */
  private async resolveEagerPwrAgentTools(
    threadId: string,
  ): Promise<ReadonlySet<string> | undefined> {
    const voiceManager = this.overlayStore.getVoiceManagerThread?.();
    if (voiceManager?.backend === "codex" && voiceManager.threadId === threadId) {
      return VOICE_MANAGER_EAGER_TOOLS;
    }
    const bindings = await this.threadInspectionTools.getThreadInspectionMessagingBindings({
      backend: "codex",
      threadId,
    });
    return bindings?.length ? MESSAGING_EAGER_TOOLS : undefined;
  }

  private async buildSupportedCodexTokenMiserConfig(params: {
    client: BackendClient;
    enabled: boolean;
  }): Promise<CodexThreadStartParams["config"] | undefined> {
    if (
      !params.enabled
      || !this.tokenMiserCodeModeReducerDescriptorPath
      || !(await this.supportsTokenMiserCodeModeReducer(params.client))
    ) {
      return undefined;
    }
    return buildCodexTokenMiserConfig(
      this.tokenMiserCodeModeReducerDescriptorPath,
    );
  }

  /**
   * Bring the Codex-side gate up: the loopback bridge the hook talks to, and
   * the plugin registration that makes Codex run the hook at all.
   *
   * Runs at boot, on every Codex turn start, and when the setting changes.
   * It used to run only when a *new* thread was created, so an app that
   * booted and resumed an existing thread had no bridge for that thread until
   * something else happened to start one — five minutes of fail-open on the
   * turn this was diagnosed from, nine large results ungated. Every call
   * after the first is cheap: the bridge start and the plugin install are
   * memoized, legacy cleanup runs at boot and managed runtime restart, and the activation record is
   * written only when its state changes.
   */
  private async prepareTokenMiserRuntime(): Promise<void> {
    if (
      !this.tokenMiserStore
      || !this.tokenMiserHookBridge
      || !this.tokenMiserPluginManager
    ) {
      return;
    }
    this.assertThreadOwnership();
    try {
      await this.threadUsageLedger.currentTokenMiserLedgerReconciliation;
      await this.tokenMiserHookBridge.start();
      const capabilities = await this.readTokenMiserServerCapabilities(
        this.codexClient,
      );
      const managedActivation =
        hasManagedTokenMiserCapabilityContract(capabilities);
      if (
        this.resolveManagedTokenMiserActivationRequiredFn()
        && !managedActivation
      ) {
        throw new Error(
          TOKEN_MISER_MANAGED_CAPABILITY_REASON,
        );
      }
      const codexRuntime = managedActivation
        ? undefined
        : await this.resolveTokenMiserCodexRuntimeFn?.();
      await Promise.all([
        managedActivation
          ? Promise.resolve()
          : codexRuntime
            ? this.tokenMiserPluginManager.ensureInstalled(codexRuntime)
            : this.tokenMiserPluginManager.ensurePluginSource(),
      ]);
      this.tokenMiserRuntimePreparationFailure = undefined;
      await this.recordTokenMiserActivation(
        this.tokenMiserReducerCapabilityState === "supported"
          ? { state: "active" }
          : {
              reason: this.tokenMiserReducerCapabilityState === "unsupported"
                ? this.resolveManagedTokenMiserActivationRequiredFn()
                  ? TOKEN_MISER_MANAGED_CAPABILITY_REASON
                  : "Codex runtime lacks Token Miser reducer model-guidance v1."
                : "Waiting for Codex to report Token Miser output reducer support.",
              state: "unavailable",
            },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.tokenMiserRuntimePreparationFailure = reason;
      backendRegistryLog.warn("Token Miser runtime preparation failed open", {
        error: reason,
      });
      // Failing open keeps the turn running, but it also makes an inert gate
      // indistinguishable from one that had nothing to gate. Record it so the
      // Settings screen can say the feature is on but not running.
      await this.recordTokenMiserActivation({ reason, state: "unavailable" });
    }
  }

  private lastRecordedTokenMiserActivation?: string;

  private async recordTokenMiserActivation(params: {
    reason?: string;
    state: TokenMiserActivationStatus["state"];
  }): Promise<void> {
    if (!this.tokenMiserStateDir) {
      return;
    }
    // Now called on every turn start; only a change is worth a file write.
    const signature = `${params.state}:${params.reason ?? ""}`;
    if (this.lastRecordedTokenMiserActivation === signature) {
      return;
    }
    this.lastRecordedTokenMiserActivation = signature;
    try {
      await mkdir(this.tokenMiserStateDir, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        path.join(this.tokenMiserStateDir, TOKEN_MISER_ACTIVATION_FILENAME),
        JSON.stringify({
          observedAt: Date.now(),
          ...(params.reason ? { reason: params.reason } : {}),
          state: params.state,
        } satisfies TokenMiserActivationStatus),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      backendRegistryLog.warn("failed to record Token Miser activation", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async downgradeUnavailableAutoExecutionMode(
    backendKind: AppServerBackendKind,
  ): Promise<ThreadExecutionMode> {
    const { backends } = await this.listBackends({ includeUnavailable: true });
    const modes = backends.find((backend) => backend.kind === backendKind)?.executionModes ?? [];
    const auto = modes.find((mode) => mode.mode === "auto");
    const defaultAvailable = modes.some((mode) => mode.mode === "default" && mode.available);
    // Only a runtime that works and lists Auto as unavailable is downgraded.
    // A missing runtime fails the start on its own, and a provider without
    // Auto keeps rejecting it.
    return auto && !auto.available && defaultAvailable ? "default" : "auto";
  }

  /**
   * Each registered Codex model provider and what its catalog read found,
   * read after the model list so the two describe the same read.
   */
  private codexModelProviderCatalogStates(): Pick<BackendSummary, "codexModelProviders"> {
    const states = this.codexModelProviderCatalog?.catalogStates() ?? [];
    this.codexProviderCatalogRetry.observe(states);
    return states.length ? { codexModelProviders: states } : {};
  }

  /**
   * Re-read the Codex model list and publish it on the cached Codex summary.
   * The retry after a failed provider read reuses a provider read that is
   * still fresh; Settings' Refresh (`rereadProviders`) reads the named
   * providers' endpoints again, or every one's. Windows re-read summaries on
   * `backend/providerStatus/updated`.
   */
  private async refreshCodexProviderCatalogs(
    options: { rereadProviders?: true | readonly string[] } = {},
  ): Promise<readonly CodexModelProviderCatalogState[]> {
    return (await this.refreshAndPublishCodexProviderCatalogs(options)).states;
  }

  /**
   * `refreshCodexProviderCatalogs`, also saying whether the read reached the
   * cached summary. A newer refresh, provider save, or runtime change can
   * supersede it while it reads.
   */
  private async refreshAndPublishCodexProviderCatalogs(
    options: { rereadProviders?: true | readonly string[] } = {},
  ): Promise<{ states: readonly CodexModelProviderCatalogState[]; published: boolean }> {
    const generation = this.codexBackendGeneration;
    const providerRevision = this.codexModelProviderRevision;
    const refreshRevision = ++this.codexModelProviderRefreshRevision;
    const reread = options.rereadProviders;
    if (reread === true) {
      this.codexModelProviderCatalog?.invalidate();
    } else {
      for (const providerId of reread ?? []) this.codexModelProviderCatalog?.invalidateProvider(providerId);
    }
    this.modelCatalog.invalidate("codex");
    const result = await this.modelCatalog.readModels("codex", reread ? "settings-refresh" : "provider-catalog-retry").then(
      (models) => ({ models }),
      (error: unknown) => ({ error }),
    );
    const states = this.codexModelProviderCatalog?.catalogStates() ?? [];
    if (
      this.closed
      || generation !== this.codexBackendGeneration
      || providerRevision !== this.codexModelProviderRevision
      || refreshRevision !== this.codexModelProviderRefreshRevision
    ) return { states, published: false };
    if ("error" in result) throw result.error;
    // A refresh from Settings that finds a provider down arms the automatic
    // retry. The retry's own refresh is ignored here; it observes on return.
    this.codexProviderCatalogRetry.observe(states);
    if (!this.codexBackendSummary) return { states, published: false };
    const { codexModelProviders: previousStates, ...summary } = this.codexBackendSummary;
    const launchpadOptions = this.buildCodexLaunchpadOptions(result.models);
    const changed = JSON.stringify([summary.launchpadOptions, previousStates ?? []])
      !== JSON.stringify([launchpadOptions, states]);
    this.codexBackendSummary = {
      ...summary,
      launchpadOptions,
      ...(states.length ? { codexModelProviders: states } : {}),
    };
    // A retry that found the same state tells windows nothing new.
    if (changed) await this.emitCodexProviderStatusUpdated();
    return { states, published: true };
  }

  /**
   * The automatic retry after a failed provider read. With a cached summary,
   * Codex is running and its model list is re-read with the providers'.
   * Without one there may be no Codex App Server, and the retry has no
   * provider discovery permit to start one, so it reads only the failed
   * providers' endpoints; the pre-discovery summary projects the catalog.
   */
  private async retryCodexProviderCatalogs(): Promise<readonly CodexModelProviderCatalogState[]> {
    if (this.codexBackendSummary) return await this.refreshCodexProviderCatalogs();
    const catalog = this.codexModelProviderCatalog;
    if (!catalog) return [];
    const before = catalog.catalogStates();
    for (const state of before) {
      if (state.status === "unavailable") catalog.invalidateProvider(state.id);
    }
    // A failed endpoint read is recorded in the catalog state.
    await catalog.listModelOptions().catch(() => []);
    if (this.closed) return [];
    // A discovery that cached a summary during the read publishes states on
    // the summary, which this read did not reach; refresh it over the
    // running Codex instead.
    if (this.codexBackendSummary) return await this.refreshCodexProviderCatalogs();
    const states = catalog.catalogStates();
    // A retry that found the same state tells windows nothing new.
    if (JSON.stringify(before) !== JSON.stringify(states)) {
      await this.emitCodexProviderStatusUpdated();
    }
    return states;
  }

  /** Windows and federation peers re-read backend summaries on this. */
  private async emitCodexProviderStatusUpdated(): Promise<void> {
    await this.emit({ backend: "codex", notification: { method: "backend/providerStatus/updated", params: { backend: "codex" } } });
  }

  /**
   * Publish a saved change to the Codex model provider list on the summary
   * every window and federation peer reads.
   *
   * A change Codex must be launched with (a provider added, removed or moved
   * to another base URL) first goes through the runtime invalidation the
   * `providers` config domain already drives: the cached summary is dropped
   * and Codex restarts only once no turn is using it. Without a summary, the
   * providers' endpoints are read through the catalog (with the catalog's own
   * key resolver; no Codex discovery) and the pre-discovery summary projects
   * them. A change that leaves the launch alone re-reads Codex's model list
   * over the open connection and joins the providers' models to it.
   */
  applyCodexModelProviderConfigChange(): Promise<void> {
    this.codexModelProviderRevision += 1;
    const revision = this.codexModelProviderRevision;
    this.codexModelProviderCatalog?.invalidate();
    this.modelCatalog.invalidate("codex");
    const publication = this.codexModelProviderPublication.then(async () => {
      // The same save may have changed the Codex launch. Whichever config
      // subscriber ran first, wait for that invalidation to settle. Its
      // failure is the runtime's to report; the provider list still has to
      // reach the windows.
      await this.synchronizeProviderRuntimeSelections().catch((error: unknown) => {
        backendRegistryLog.warn("Codex runtime update after a model provider change failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      if (this.closed || revision !== this.codexModelProviderRevision) return;
      if (this.codexBackendSummary) {
        try {
          if ((await this.refreshAndPublishCodexProviderCatalogs()).published) return;
        } catch (error) {
          backendRegistryLog.warn("Codex model list unavailable after a model provider change", {
            error: error instanceof Error ? error.message : String(error),
          });
          await this.publishKnownCodexProviderModels(revision);
        }
      }
      if (!this.codexBackendSummary) {
        // A failed endpoint read is recorded in the catalog state and leaves
        // the provider's listed models.
        await this.codexModelProviderCatalog?.listModelOptions().catch(() => []);
        // A provider whose endpoint is down is read again later.
        if (!this.closed && revision === this.codexModelProviderRevision) {
          this.codexProviderCatalogRetry.observe(this.codexModelProviderCatalog?.catalogStates() ?? []);
        }
      }
      if (this.closed || revision !== this.codexModelProviderRevision) return;
      await this.emitCodexProviderStatusUpdated();
    });
    this.codexModelProviderPublication = publication.catch(() => undefined);
    return publication;
  }

  /**
   * When Codex's own model list cannot be read after a provider change, keep
   * the OpenAI models the summary already has and replace only the provider
   * models. The model list read reads Codex's own list first, so its failure
   * left the provider endpoints unread: read them here. A removed provider
   * leaves; a newer save publishes its own list instead.
   */
  private async publishKnownCodexProviderModels(revision: number): Promise<void> {
    const refreshRevision = this.codexModelProviderRefreshRevision;
    await this.codexModelProviderCatalog?.listModelOptions().catch(() => []);
    const summary = this.codexBackendSummary;
    if (
      !summary || this.closed
      || revision !== this.codexModelProviderRevision
      || refreshRevision !== this.codexModelProviderRefreshRevision
    ) return;
    const { codexModelProviders: _previousStates, ...rest } = summary;
    const ownModels = (summary.launchpadOptions?.models ?? []).filter((model) => !model.providerId);
    const known = this.codexModelProviderCatalog?.knownCatalog() ?? { models: [], states: [] };
    this.codexBackendSummary = {
      ...rest,
      launchpadOptions: this.buildCodexLaunchpadOptions([...ownModels, ...known.models]),
      ...(known.states.length ? { codexModelProviders: known.states } : {}),
    };
    // The failed model list read never observed these states; a provider
    // whose endpoint is down is read again later.
    this.codexProviderCatalogRetry.observe(known.states);
  }

  /** Settles once every saved provider change so far is published. */
  async settleCodexModelProviderPublication(): Promise<void> {
    await this.codexModelProviderPublication;
  }

  private readCodexDefaultModelsOnce(
    callerReason: BackendModelCatalogCallerReason,
  ): Promise<BackendModelOption[]> {
    return this.modelCatalog.readModels("codex", callerReason);
  }

  private async getBackendLaunchpadOptions(
    backend: AppServerBackendKind,
    callerReason: BackendModelCatalogCallerReason,
  ): Promise<BackendLaunchpadOptions | undefined> {
    if (backend === "claude") return this.claudeBackend.summary().launchpadOptions;
    if (isAcpBackendId(backend)) {
      return this.acpBackend.getLaunchpadOptions(backend);
    }

    const models = await this.readCodexDefaultModelsOnce(callerReason).catch(() => []);
    return this.buildCodexLaunchpadOptions(models);
  }

  private buildCodexLaunchpadOptions(models: BackendModelOption[]): BackendLaunchpadOptions | undefined {
    return buildLaunchpadOptions("codex", models, { allowFallbackModels: this.codexOpenAiProviderEnabled });
  }

  private isConfiguredCodexHelperModel(model: string | undefined): boolean {
    const providerId = model ? parseCodexProviderModelId(model).providerId : undefined;
    return this.resolveCodexModelProvidersFn().some((provider) => provider.id === providerId);
  }

  private listActiveCodexWorkThreadIds(): string[] {
    const threadIds = new Set(this.context.turnState.startReservationThreadIds());
    for (const candidate of this.context.turnState.retryOperations()) {
      if (candidate.kind === "compact") threadIds.add(candidate.params.threadId);
    }
    for (const key of this.context.turnState.executionKeys()) {
      const parsed = parseThreadTurnKeyBody(key);
      if (parsed) threadIds.add(parsed.threadId);
    }
    for (const key of this.context.turnState.registeredTurnKeys()) {
      const parsed = parseActiveTurnKey(key);
      if (parsed?.backend === "codex") threadIds.add(parsed.threadId);
    }
    return [...threadIds];
  }

  private hasActiveCodexWork(): boolean {
    if (
      this.nativeVoiceLeases > 0
      || this.context.turnState.startReservationCount > 0
      || this.context.turnState.executionCount > 0
    ) {
      return true;
    }
    // An accepted compaction may not have emitted turn/started yet. It still
    // owns work on the process until its terminal notification is observed.
    for (const candidate of this.context.turnState.retryOperations()) {
      if (candidate.kind === "compact") return true;
    }
    for (const key of this.context.turnState.registeredTurnKeys()) {
      if (key.startsWith("codex:")) {
        return true;
      }
    }
    return false;
  }

  private subscribeClient(backend: AppServerBackendKind, client: BackendClient): void {
    this.unsubscribers.push(
      client.onNotification(async (notification) => {
        const codexStartDelivery = backend === "codex" && notification.method === "turn/started"
          ? this.context.turnState.beginStartDelivery(notification.params.threadId, turnIdFromStartedNotification(notification as Extract<AppServerNotification, { method: "turn/started" }>))
          : undefined;
        if (backend === "codex" && (notification.method === "turn/completed"
          || notification.method === "turn/failed" || notification.method === "turn/cancelled")) {
          this.context.turnState.observeTurnTerminal(notification.params.threadId, turnIdFromTerminalNotification(notification));
        }
        try {
          logBackendLifecycleNotification(backend, notification);
          // The registry announces its own revert once the rewind is recorded,
          // so the marker arrives with the event.
          if (backend === "codex" && notification.method === "thread/rewound") {
            const revert = this.codexRevertsInFlight.get(notification.params.threadId);
            if (revert) {
              revert.reported = true;
              return;
            }
          }
          // Match the client's running-turn ownership before the first await;
          // exit can arrive while lifecycle delivery is still in progress.
          if (backend === "codex" && notification.method === "turn/started") {
            const started = notification as Extract<AppServerNotification, { method: "turn/started" }>;
            const candidate = this.context.turnState.retryOperation(started.params.threadId);
            if (candidate?.kind === "compact") {
              this.context.turnState.updateRetry(candidate, {
                lifecycleStarted: true,
                ...(candidate.turnId?.startsWith("pending:") ? { turnId: turnIdFromStartedNotification(started) } : {}),
              });
            }
          }
          const archiveWorkspaceChanged = this.threadArchiveCoordinator.invalidateArchiveCleanupForNotification(backend, notification, "provider");
          const archiveReferences = this.threadArchiveCoordinator.prepareArchiveReferenceChanges(backend, notification);
          if (archiveWorkspaceChanged && this.threadArchiveCoordinator.archiveWorktreeRemovalAdmissionRecords.size) await this.threadArchiveCoordinator.prepareArchiveWorkspaceChanges(backend, notification, archiveWorkspaceChanged);
          if (archiveReferences) await archiveReferences;
          if (backend === "codex" && notification.method === "account/updated") {
            this.forgetCodexAccountRateLimits();
          }
          if (
            backend === "codex"
            && notification.method === "account/rateLimits/updated"
          ) {
            const changed = await this.updateCachedCodexRateLimits(
              notification.params.rateLimits,
            );
            if (changed) {
              await this.scheduleCodexRateLimitBroadcast({
                backend,
                notification,
              });
            }
            return;
          }
          if (
            backend === "codex" &&
            notification.method === "thread/codexSettings/observed"
          ) {
            await this.recordObservedCodexSettings(notification);
          }
          if (this.shouldInvalidateThreadListCacheForNotification(notification.method)) {
            this.invalidateThreadListCache(backend);
          }
          if (notification.method === "thread/archived") {
            await this.observeArchivedThreads(
              [{ backend, threadId: notification.params.threadId }], Date.now(), { promoteSubthreads: true },
            );
            if (backend === "codex") await this.threadArchiveCoordinator.archiveTokenMiserThread(notification.params.threadId);
            await this.threadArchiveCoordinator.cleanupMessagingForArchivedThread({
              backend,
              threadId: notification.params.threadId,
              origin: "thread-archive",
            });
          }
          if (notification.method === "thread/unarchived") {
            if (backend === "codex") await this.threadArchiveCoordinator.restoreTokenMiserThread(notification.params.threadId);
            await this.overlayStore.setThreadArchiveTombstone({
              backend,
              threadId: notification.params.threadId,
              restoredAt: Date.now(),
            });
            this.threadArchiveCoordinator.clearArchivedMessagingCleanupCache({
              backend,
              threadId: notification.params.threadId,
            });
          }
          const noticeThreadId = "threadId" in notification.params
            ? readOptionalString(notification.params.threadId)
            : undefined;
          const headlessErrorNoticeContext = noticeThreadId && (
            notification.method === "error"
            || notification.method === "warning"
            || notification.method === "turn/completed"
            || notification.method === "turn/cancelled"
            || notification.method === "turn/failed"
            || (notification.method === "thread/status/changed"
              && readStatusType(notification.params.status) === "systemError"))
              ? this.headlessAutomation.headlessAutomationErrorNoticeContext(
                  backend,
                  noticeThreadId,
                )
              : undefined;
          if (backend === "codex" && notification.method === "item/completed") {
            const item = readRecord(notification.params.item);
            if (item?.type === "agentMessage" && notification.params.turnId) {
              this.tokenMiserDiagnostics?.recordNarration(
                notification.params.threadId, notification.params.turnId,
                item.phase, readOptionalString(item.text) ?? "",
              );
            }
          }
          await this.headlessAutomation.emitHeadlessAutomationLifecycle(backend, notification);
          await this.emit({
            backend,
            notification,
            ...(headlessErrorNoticeContext
              ? { errorNoticeContext: headlessErrorNoticeContext }
              : {}),
          }, undefined, codexStartDelivery);
          if (
            backend === "codex"
            && (
              notification.method === "turn/completed"
              || notification.method === "turn/failed"
              || notification.method === "turn/cancelled"
            )
          ) {
            this.tokenMiserDiagnostics?.endTurn(notification.params.threadId);
            await this.tokenMiserStore?.flushThread(notification.params.threadId);
            await this.codexRuntimeSupervisor.handleCodexTurnTerminalForInvalidIdRecovery(
              notification as Extract<
                AppServerNotification,
                { method: "turn/completed" | "turn/failed" | "turn/cancelled" }
              >,
            );
          }
        } finally {
          if (codexStartDelivery) this.context.turnState.endStartDelivery(codexStartDelivery);
        }
      }),
    );

    if (client.onRequest) {
      this.unsubscribers.push(
        client.onRequest(async (request) => await this.handleServerRequest(backend, request)),
      );
    }
  }

  private async recordObservedCodexSettings(
    notification: AppServerNotification,
  ): Promise<void> {
    if (notification.method !== "thread/codexSettings/observed") {
      return;
    }
    const params = notification.params as {
      fastMode?: unknown;
      model?: unknown;
      rawServiceTier?: unknown;
      reasoningEffort?: unknown;
      serviceTier?: unknown;
      threadId?: unknown;
    };
    if (typeof params.threadId !== "string") {
      return;
    }
    const observed = {
      ...(typeof params.fastMode === "boolean" ? { fastMode: params.fastMode } : {}),
      ...(typeof params.serviceTier === "string" || params.serviceTier === null
        ? { serviceTier: params.serviceTier }
        : {}),
      ...(typeof params.rawServiceTier === "string" || params.rawServiceTier === null
        ? { rawServiceTier: params.rawServiceTier }
        : {}),
      observedAt: Date.now(),
    };
    this.observedCodexSettingsByThread.set(params.threadId, observed);
    const observedModel = typeof params.model === "string" ? params.model : undefined;
    const observedReasoningEffort =
      typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined;
    if (observedModel || observedReasoningEffort) {
      const current = await this.overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: params.threadId,
      });
      const modelSettings = {
        model: observedModel ?? current?.model,
        reasoningEffort: observedReasoningEffort ?? current?.reasoningEffort,
        serviceTier: current?.serviceTier,
        fastMode: current?.fastMode,
      };
      await this.overlayStore.setThreadModelSettings({
        backend: "codex",
        threadId: params.threadId,
        ...modelSettings,
      });
      this.invalidateThreadListCache("codex");
      await this.emit({
        backend: "codex",
        notification: {
          method: "thread/modelSettings/updated",
          params: {
            threadId: params.threadId,
            ...modelSettings,
          },
        },
      });
    }
    backendRegistryLog.info("codex thread settings observed", {
      threadId: params.threadId,
      model: observedModel ?? null,
      fastMode: observed.fastMode ?? null,
      reasoningEffort: observedReasoningEffort ?? null,
      serviceTier: observed.serviceTier ?? null,
      rawServiceTier: observed.rawServiceTier ?? null,
    });
  }

  private getClient(
    backend: AppServerBackendKind,
    // executionMode is retained for documentation symmetry with callers
    // that pass per-turn approvalPolicy/sandboxPolicy overrides; it no
    // longer routes since the dual-client architecture collapsed to one.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    executionMode: ThreadExecutionMode = "default",
  ): BackendClient {
    if (isAcpBackendId(backend)) {
      throw new Error(`ACP backend ${backend} is not available through the built-in client router`);
    }

    if (backend !== "codex") {
      throw new Error(`Backend ${backend} is not available through the built-in client router`);
    }

    return this.codexClient;
  }

  private buildThreadListCacheKey(params: {
    archived?: boolean;
    backend?: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    enrichDirectories?: boolean;
    filter?: string;
    forceRefresh?: boolean;
    limit?: number;
    maxPages?: number;
    skipArchivedMetadataRefresh?: boolean;
  }): string {
    const includesCodex = params.backend === undefined || params.backend === "codex";
    const codexDirectoryBackfill =
      includesCodex
      && !params.archived
      && params.enrichDirectories === false
        ? shouldBackfillCodexDirectoryRelationships(params.callerReason)
        : undefined;

    return JSON.stringify({
      archived: params.archived === true,
      backend: params.backend ?? "all",
      codexDirectoryBackfill,
      enrichDirectories: params.enrichDirectories === true,
      filter: params.filter?.trim() ?? "",
      limit: params.limit,
      maxPages: params.maxPages,
      skipArchivedMetadataRefresh: params.skipArchivedMetadataRefresh === true,
    });
  }

  private findReusableThreadListCache(
    params: {
      archived?: boolean;
      backend?: AppServerBackendKind;
      callerReason?: ThreadListCallerReason;
      enrichDirectories?: boolean;
      filter?: string;
      forceRefresh?: boolean;
      limit?: number;
      maxPages?: number;
      skipArchivedMetadataRefresh?: boolean;
    },
    cacheKey: string,
    now: number,
  ): ThreadListCacheHit | undefined {
    if (params.forceRefresh === true) {
      return this.readPendingThreadListCache(cacheKey, "exact");
    }

    const exact = this.readFreshThreadListCache(cacheKey, now, "exact");
    if (exact) {
      return exact;
    }

    const includesCodex = params.backend === undefined || params.backend === "codex";
    if (
      !includesCodex ||
      params.archived === true ||
      params.enrichDirectories !== false ||
      shouldBackfillCodexDirectoryRelationships(params.callerReason)
    ) {
      return undefined;
    }

    // Directory-enriched rows include the summary data requested by cheap
    // consumers. Reuse the same pending or completed provider observation;
    // the reverse direction cannot supply missing directory relationships.
    const enrichedKey = this.buildThreadListCacheKey({
      ...params,
      enrichDirectories: true,
    });
    return this.readFreshThreadListCache(enrichedKey, now, "navigation-shared");
  }

  private readFreshThreadListCache(
    cacheKey: string,
    now: number,
    source: ThreadListCacheHit["source"],
  ): ThreadListCacheHit | undefined {
    const cached = this.threadListCache.get(cacheKey);
    if (cached?.threads && (cached.expiresAt ?? 0) > now) {
      return {
        cacheKey,
        expiresInMs: Math.max(0, (cached.expiresAt ?? 0) - now),
        pending: false,
        source,
        threadCount: cached.threads.length,
        value: cached.threads,
      };
    }
    if (cached?.promise) {
      return {
        cacheKey,
        pending: true,
        source,
        value: cached.promise,
      };
    }
    return undefined;
  }

  private readPendingThreadListCache(
    cacheKey: string,
    source: ThreadListCacheHit["source"],
  ): ThreadListCacheHit | undefined {
    const cached = this.threadListCache.get(cacheKey);
    if (!cached?.promise) {
      return undefined;
    }
    return {
      cacheKey,
      pending: true,
      source,
      value: cached.promise,
    };
  }

  // Display metadata and navigation refreshes do not change checkout ownership.
  // Only actual workspace mutations may invalidate a removal's safety scan.
  private invalidateThreadListCache(backend?: AppServerBackendKind, workspaceChanged = false, threadId?: string, paths: readonly string[] = []): void {
    if (workspaceChanged) {
      this.threadArchiveCoordinator.advanceArchiveWorkspaceRevision();
      if (backend) this.threadArchiveCoordinator.recordArchiveWorkspaceChange(threadId ? buildThreadIdentityKey(backend, threadId) : undefined, paths, paths.length > 0);
    }
    if (!backend) {
      this.threadArchiveCoordinator.invalidateArchiveCleanupReads(undefined, undefined, workspaceChanged);
      this.threadListCache.clear();
      return;
    }
    for (const key of this.threadListCache.keys()) {
      if (!key.includes(`"backend":"${backend}"`) && !key.includes('"backend":"all"')) continue;
      this.threadListCache.delete(key);
    }
  }

  refreshThreadDirectoryRelationship(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    return this.threadDirectoryService.refreshThreadDirectoryRelationship(params);
  }

  private shouldInvalidateThreadListCacheForNotification(method: string): boolean {
    return (
      method === "navigation/threadDirectories/updated" ||
      method === "thread/branch/updated" ||
      method === "thread/archived" ||
      method === "thread/acpRuntime/updated" ||
      method === "thread/executionMode/queueCleared" ||
      method === "thread/executionMode/queued" ||
      method === "thread/executionMode/updated" ||
      method === "thread/name/updated" ||
      method === "thread/parent/cleared" ||
      method === "thread/parent/set" ||
      method === "thread/rewound" ||
      method === "thread/started" ||
      method === "thread/status/changed" ||
      method === "thread/subAgents/updated" ||
      method === "thread/subthreadOrder/updated" ||
      method === "thread/subthreadsCollapsed/updated" ||
      method === "thread/unarchived" ||
      method === "turn/started" ||
      method === "turn/cancelled" ||
      method === "turn/completed" ||
      method === "turn/failed"
    );
  }

  private async listCodexThreads(params: {
    archived?: boolean;
    enrichDirectories?: boolean;
    filter?: string;
    limit?: number;
    maxPages?: number;
    skipArchivedMetadataRefresh?: boolean;
  } = {}, diagnostics?: {
    callerReason?: string;
    ownerId?: string;
  }): Promise<AppServerThreadSummary[]> {
    const observedFilterThreadIds =
      this.observedCodexThreadIdsMatchingFilter(params.filter);
    let incomplete = false;
    // Codex applies searchTerm before returning rows. During its naming lag,
    // fetch unfiltered candidates only when a live observed title matches the
    // query, then retain just those thread ids alongside provider matches.
    const [providerFilteredThreads, observedFilterCandidates] =
      await Promise.all([
        this.codexClient
          // A requested page cap already has its own registry cache key and
          // cannot authorize absence. Retry an unexpectedly short walk sooner.
          .listThreads(params, diagnostics, params.maxPages === undefined ? () => { incomplete = true; } : undefined)
          .catch(async (error) => {
            if (
              diagnostics?.callerReason === "archive-cleanup"
              || diagnostics?.callerReason === "startup-provider-refresh"
              || diagnostics?.callerReason === "authentication-recovery"
            ) {
              throw error;
            }

            // A Codex executable that fails to answer has rows this listing
            // lacks. With no executable there is no Codex inventory to lack.
            incomplete ||= await this.hasCodexExecutable();
            return [];
          }),
        observedFilterThreadIds.size > 0
          ? this.codexClient.listThreads(
              {
                ...params,
                filter: undefined,
                limit: undefined,
                maxPages: undefined,
              },
              diagnostics
                ? {
                    ...diagnostics,
                    callerReason:
                      `${diagnostics.callerReason ?? "thread-list"}:observed-name-filter`,
                  }
                : undefined,
            ).catch((error) => {
              backendRegistryLog.debug(
                "live Codex name filter fallback failed",
                {
                  error: error instanceof Error ? error.message : String(error),
                  filter: params.filter,
                },
              );
              return [];
            })
          : Promise.resolve([]),
      ]);
    const providerFilteredThreadIds = new Set(
      providerFilteredThreads.map((thread) => thread.id),
    );
    const defaultThreadsById = new Map(
      providerFilteredThreads.map((thread) => [thread.id, thread]),
    );
    for (const thread of observedFilterCandidates) {
      if (
        observedFilterThreadIds.has(thread.id)
        && !defaultThreadsById.has(thread.id)
      ) {
        defaultThreadsById.set(thread.id, thread);
      }
    }
    const defaultThreads = [...defaultThreadsById.values()];
    const nativeSubAgentThreads =
      !params.archived &&
      !params.filter?.trim() &&
      defaultThreads.length > 0 &&
      this.codexClient.listNativeSubAgentThreads
        ? await this.codexClient.listNativeSubAgentThreads({
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          }, diagnostics).catch((error) => {
            backendRegistryLog.debug("native Codex sub-agent discovery failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            incomplete = true;
            return [];
          })
        : [];
    const groupedThreads = groupCodexNativeSubAgents({
      nativeThreads: nativeSubAgentThreads,
      now: Date.now(),
      parentThreads: defaultThreads,
    });
    // The sidebar deliberately flattens nested native workers below their
    // nearest ordinary thread. Keep accounting and the right-rail cards on
    // that same visible owner instead of writing them to a hidden worker's
    // overlay.
    for (const parent of groupedThreads) {
      for (const subAgent of parent.codexNativeSubAgents ?? []) {
        this.subAgentMonitorService.setCodexNativeSubAgentParent(subAgent.threadId, parent.id);
      }
    }
    const allThreads = groupedThreads.map((thread) => ({
      ...thread,
      executionMode: "default" as const,
    }));
    const threadsWithPending = this.withPendingStartedThreads(
      "codex",
      allThreads,
      params,
    );

    const readOverlays = this.overlayStore.getThreadListingOverlayStates ?? this.overlayStore.getThreadOverlayStates;
    const overlaysByThreadId = await readOverlays.call(this.overlayStore, {
      backend: "codex",
      threadIds: [
        ...new Set([
          ...threadsWithPending.map((thread) => thread.id),
          ...nativeSubAgentThreads.map((thread) => thread.id),
        ]),
      ],
    });
    // Discovery repairs worker cards and parent pricing from durable child
    // turn usage. Only these native workers' usage activities are read;
    // every row keeps the compact listing projection.
    const nativeIds = new Set(nativeSubAgentThreads.map((thread) => thread.id));
    const usageThreadIds = [...new Set(threadsWithPending.flatMap((thread) =>
      (thread.codexNativeSubAgents ?? []).map((worker) => worker.threadId),
    ))].filter((id) => nativeIds.has(id)
      && overlaysByThreadId[id]?.handoffOrigin?.groupingMode !== "subthread");
    const usageActivitiesByThreadId = await this.threadUsageLedger.readThreadUsageActivities("codex", usageThreadIds);
    // Native-worker cards only: a primary-key range per parent that never
    // reads the parent's Token Miser gate history.
    const nativeCardsByThreadId = await this.overlayStore.listThreadSubAgentsByMonitorIdPrefix({
      backend: "codex",
      threadIds: threadsWithPending.map((thread) => thread.id),
      monitorIdPrefix: CODEX_NATIVE_MONITOR_ID_PREFIX,
    });
    await this.subAgentMonitorService.reconcileDiscoveredCodexNativeSubAgents({
      nativeCardsByThreadId,
      nativeThreads: nativeSubAgentThreads,
      overlaysByThreadId,
      parentThreads: threadsWithPending,
      usageActivitiesByThreadId,
    });
    await this.subAgentMonitorService.reconcilePersistedCodexNativeSubAgents(threadsWithPending, nativeCardsByThreadId);
    const visibleThreads = threadsWithPending.filter(
      (thread) => overlaysByThreadId[thread.id]?.archiveTombstonedAt === undefined,
    );
    // A search-filtered or page-limited list is a subset, not the profile, so
    // it must not become the missing-thread denominator.
    if (
      !params.archived
      && !params.filter
      && params.limit === undefined
      && params.maxPages === undefined
    ) {
      this.recordCodexVisibleThreadCount(visibleThreads.length);
    }
    // Archive cleanup also lists archived threads. Reading that collection
    // must not try to reopen their workspaces or classify them as missing.
    if (!params.archived) {
      this.threadWorkspaceService.schedulePendingCodexWorkspaceCwdSyncs({
        overlaysByThreadId,
        threads: visibleThreads,
      });
    }
    const reconciledOverlaysByThreadId =
      await this.threadDirectoryService.reconcileCodexDirectoryRelationshipsFromSource({
        diagnostics,
        overlaysByThreadId,
        threads: visibleThreads,
      });
    Object.assign(overlaysByThreadId, reconciledOverlaysByThreadId);
    if (
      !params.archived &&
      params.enrichDirectories === false &&
      shouldBackfillCodexDirectoryRelationships(diagnostics?.callerReason)
    ) {
      const updatedOverlaysByThreadId =
        await this.threadDirectoryService.backfillMissingCodexDirectoryRelationships({
          diagnostics,
          overlaysByThreadId,
          threads: visibleThreads,
        });
      Object.assign(overlaysByThreadId, updatedOverlaysByThreadId);
    }

    const enrichedThreads = visibleThreads.map((thread) => {
      const overlay = overlaysByThreadId[thread.id];
      return {
        ...thread,
        ...projectOverlayThreadTitle(thread, overlay),
        ...this.subAgentMonitorService.persistedCodexNativeSubAgentDisclosure(thread, nativeCardsByThreadId[thread.id]),
        executionMode: overlay?.executionMode ?? thread.executionMode,
        model: overlay?.model ?? thread.model,
        reasoningEffort: overlay?.reasoningEffort ?? thread.reasoningEffort,
        serviceTier: overlay?.serviceTier ?? thread.serviceTier,
        fastMode: overlay?.fastMode ?? thread.fastMode,
        linkedDirectories: dedupeLinkedDirectoriesByNormalizedIdentity(
          thread.linkedDirectories,
        ),
      };
    });

    const statusReconciledThreads = enrichedThreads
      .map((thread) => this.reconcileCodexThreadListStatus(thread))
      .map((thread) => this.withObservedThreadName(thread));
    const normalizedFilter = params.filter?.trim().toLowerCase();
    const filteredThreads = normalizedFilter && observedFilterThreadIds.size > 0
      ? statusReconciledThreads.filter(
          (thread) =>
            providerFilteredThreadIds.has(thread.id)
            || thread.title.toLowerCase().includes(normalizedFilter),
        )
      : statusReconciledThreads;

    const threads = filteredThreads.sort(
      (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
    if (incomplete) this.incompleteThreadLists.add(threads);
    return threads;
  }

  private retainedOwnerThreadsMissingFrom(
    threads: AppServerThreadSummary[],
    params: { archived?: boolean; filter?: string },
  ): AppServerThreadSummary[] {
    const present = new Set(threads.filter(thread => thread.source === "codex").map(thread => thread.id));
    return this.retainedOwnerThreadStorage?.list().filter(thread => !present.has(thread.id)
      && (thread.archivedAt !== undefined) === (params.archived === true)
      && pendingStartedThreadMatchesFilter(thread, params.filter)) ?? [];
  }

  private mergeRetainedOwnerThreads(
    threads: AppServerThreadSummary[],
    params: { archived?: boolean; filter?: string },
    oppositeNativeIds: ReadonlySet<string>,
  ): AppServerThreadSummary[] {
    const retained = this.retainedOwnerThreadsMissingFrom(threads, params).filter(thread => !oppositeNativeIds.has(thread.id));
    if (!retained.length) return threads;
    return this.inheritIncompleteThreadList([...threads, ...retained]
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)), threads);
  }

  private async withRetainedOwnerThreads(
    threads: AppServerThreadSummary[],
    params: { archived?: boolean; filter?: string; deadlineAt?: number },
  ): Promise<AppServerThreadSummary[]> {
    this.confirmRetainedNativeOwners(threads);
    if (!this.retainedOwnerThreadsMissingFrom(threads, params).length) return threads;
    // A missing active row may be a native archived member (and vice versa).
    // Retained identity must not manufacture membership in the other collection.
    const opposite = await this.codexClient.listThreads({ archived: params.archived !== true,
      enrichDirectories: false, skipArchivedMetadataRefresh: true, requireComplete: true, deadlineAt: params.deadlineAt },
    { callerReason: "retained-owner-membership", ownerId: this.threadListCacheOwnerId }).catch(() => {
      this.incompleteThreadLists.add(threads);
      return [];
    });
    this.confirmRetainedNativeOwners(opposite);
    // Read retention again after awaiting discovery: a publication or retirement
    // committed while this walk was pending remains authoritative.
    return this.mergeRetainedOwnerThreads(threads, params, new Set(opposite.map(thread => thread.id)));
  }

  private confirmRetainedNativeOwners(threads: readonly AppServerThreadSummary[]): void {
    if (this.closed || !threads.length) return;
    this.retainedOwnerThreadStorage?.confirmNativeThreads(threads.filter(thread => thread.source === "codex").map(thread => thread.id));
  }

  private withPendingStartedThreads(
    backend: AppServerBackendKind,
    threads: AppServerThreadSummary[],
    params: { archived?: boolean; filter?: string } = {},
  ): AppServerThreadSummary[] {
    const resolvedThreads = threads.map((thread) => {
      const pendingThreadKey = buildThreadIdentityKey(backend, thread.id);
      const pendingThread = this.pendingStartedThreads.get(pendingThreadKey);
      if (!pendingThread) {
        return thread;
      }
      if (pendingStartedThreadWorkspaceMatches(thread, pendingThread)) {
        this.pendingStartedThreads.delete(pendingThreadKey);
        return thread;
      }
      // Codex can briefly surface a fork with the copied parent cwd. Keep the
      // workspace PwrAgent just prepared until thread/list reports that same
      // repository/worktree relationship, while still accepting fresh
      // provider title and status metadata.
      return retainPendingStartedThreadWorkspace(thread, pendingThread);
    });
    const threadIds = new Set(resolvedThreads.map((thread) => thread.id));
    if (params.archived === true) {
      return resolvedThreads;
    }

    const pendingThreads = [...this.pendingStartedThreads.values()].filter(
      (thread) =>
        thread.source === backend &&
        !threadIds.has(thread.id) &&
        pendingStartedThreadMatchesFilter(thread, params.filter),
    );
    if (pendingThreads.length === 0) {
      return resolvedThreads;
    }

    return [...pendingThreads, ...resolvedThreads].sort(
      (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
  }

  /**
   * Re-describe the cached summary's runtime identity after a managed Codex
   * selection change.
   *
   * Nothing else invalidates that cache on this path: it is cleared only when
   * a `providers.*` fingerprint changes, and the managed channel turns over
   * without one. A passive `listBackends` therefore keeps serving the summary
   * built for the executable that was just replaced, so the providers panel
   * would name the superseded build's publisher and version.
   *
   * A change that leaves no managed runtime drops both fields rather than
   * guessing at the vendor executable taking over — the next discovery names
   * it, and until then silence beats the wrong publisher.
   */
  /**
   * A new Codex app server generation took over new work after the
   * installation under the old one changed (`app-server-generation-pool.ts`).
   * Describe the version it reported, and forget what was read from the old
   * process: its models and server capabilities.
   */
  private handleCodexAppServerGenerationPromoted(
    event: CodexAppServerGenerationPromotion,
  ): void {
    this.modelCatalog.invalidate("codex");
    this.tokenMiserServerCapabilities.delete(this.codexClient);
    const version = event.current?.version;
    if (this.codexBackendSummary && version) {
      // Capabilities are derived from the version; describe both for the new server.
      this.codexBackendSummary = {
        ...this.codexBackendSummary,
        serverVersion: version,
        capabilities: buildCapabilities(this.codexBackendSummary.methods ?? [], "codex", version),
      };
    }
  }

  private redescribeCachedCodexRuntime(
    runtime?: ManagedCodexSelectionChange["runtime"],
  ): void {
    if (!this.codexBackendSummary) {
      return;
    }
    this.codexBackendSummary = {
      ...this.codexBackendSummary,
      runtimeBuild: runtime ? codexRuntimeBuild(runtime.command) : undefined,
      serverVersion: runtime?.metadata.version,
    };
  }

  /**
   * The Codex provider projection and its durable executable observation, the
   * observation dropped when it no longer describes the current
   * configuration. One snapshot read serves both, so a summary cannot pair a
   * validation error with a `lastKnownGood` from a different revision.
   *
   * The pre-discovery summary is built entirely from this; the discovered
   * summary falls back to it for the version and provenance that live runtime
   * resolution could not name.
   */
  private readCodexProvider(): {
    lastKnownGood?: ConfigDomainMap["providers"]["codex"]["lastKnownGood"];
    provider?: ConfigDomainMap["providers"]["codex"];
  } {
    const provider = this.configStore?.read("providers").codex;
    return {
      ...(provider && providerLastKnownGoodMatchesConfig(provider)
        ? { lastKnownGood: provider.lastKnownGood }
        : {}),
      ...(provider ? { provider } : {}),
    };
  }

  /**
   * The cached summary with the limits the plan-limit store holds now. The
   * same object comes back until either changes, so an unchanged reading
   * leaves listeners' summaries alone.
   */
  private codexSummaryWithLimits(summary: BackendSummary): BackendSummary {
    const rateLimits = this.planLimits.limits("codex");
    const view = this.codexSummaryView;
    if (view?.base === summary && view.rateLimits === rateLimits) return view.summary;
    // A summary built from an earlier view carries that view's limits.
    const { rateLimits: _earlier, ...base } = summary;
    const next: BackendSummary = rateLimits === undefined ? base : { ...base, rateLimits };
    this.codexSummaryView = { base: summary, rateLimits, summary: next };
    return next;
  }

  private readCodexBackendSummary(): BackendSummary {
    if (this.codexBackendSummary) {
      // A summary cached by `discoverCodexBackend` carries no pending flag, and
      // a failing one is invalidated only by a provider fingerprint change —
      // which a later successful discovery does not produce. Re-deriving the
      // flag here keeps a summary cached mid-discovery from reading as a
      // settled "no provider" for the rest of the process.
      return this.withCodexDiscoveryPending(this.codexSummaryWithLimits(this.codexBackendSummary));
    }
    const { lastKnownGood, provider } = this.readCodexProvider();
    const available = Boolean(lastKnownGood?.selectedCommand);
    const methods: string[] = [];
    const capabilities = buildCapabilities(methods, "codex", lastKnownGood?.selectedVersion);
    // Only claim discovery is outstanding when it actually is. A discovery
    // that ran and selected nothing records no `validation.error`, so this
    // default used to describe a completed discovery as incomplete — and the
    // no-backend notice renders this string as its operator-facing detail and
    // copy text.
    const unavailableReason = provider?.validation.error
      ?? (this.resolveCodexDiscoveryPendingFn()
        ? "Codex discovery has not completed yet."
        : "No Codex executable was found on this machine.");
    return this.withCodexDiscoveryPending({
      kind: "codex",
      label: BACKEND_LABELS.codex,
      available,
      serverVersion: lastKnownGood?.selectedVersion,
      runtimeBuild: codexRuntimeBuild(lastKnownGood?.selectedCommand),
      methods,
      capabilities,
      ...this.preDiscoveryCodexModelOptions(),
      executionModes: [
        {
          mode: "default",
          label: EXECUTION_MODE_SUMMARIES.default.label,
          available,
          isDefault: true,
          ...(available ? {} : { unavailableReason }),
        },
        codexAutoExecutionMode(available, lastKnownGood?.selectedVersion),
        {
          mode: "full-access",
          label: EXECUTION_MODE_SUMMARIES["full-access"].label,
          available,
          ...(available ? {} : { unavailableReason }),
        },
      ],
      ...(available ? {} : { unavailableReason }),
    });
  }

  /**
   * Known models and catalog states for configured providers, plus OpenAI
   * fallback models when enabled. Nothing is fetched here.
   */
  private preDiscoveryCodexModelOptions(): Pick<BackendSummary, "launchpadOptions" | "codexModelProviders"> {
    const known = this.codexModelProviderCatalog?.knownCatalog() ?? { models: [], states: [] };
    return {
      launchpadOptions: this.buildCodexLaunchpadOptions(
        this.codexOpenAiProviderEnabled && known.models.length
          ? [...getBackendFallbackModels("codex"), ...known.models] : known.models,
      ),
      ...(known.states.length ? { codexModelProviders: known.states } : {}),
    };
  }

  private async updateCachedCodexRateLimits(value: unknown): Promise<boolean> {
    const rateLimits = extractRateLimitSummaries(value);
    if (rateLimits.length === 0) {
      return false;
    }
    const backendGeneration = this.codexBackendGeneration;
    // The transport does not serialize notifications, and each update carries
    // only some windows. A newer notification therefore does not supersede
    // this one: queue it so updates merge in arrival order, each with the
    // account read after it arrived.
    const work = this.codexRateLimitsUpdateTail.then(() =>
      this.applyCachedCodexRateLimits({ rateLimits, backendGeneration }));
    this.codexRateLimitsUpdateTail = work.catch(() => undefined);
    return await work;
  }

  private async applyCachedCodexRateLimits(params: {
    rateLimits: BackendRateLimitSummary[];
    backendGeneration: number;
  }): Promise<boolean> {
    const { rateLimits, backendGeneration } = params;
    const accountKey = await this.captureUsageAccount("codex");
    if (backendGeneration !== this.codexBackendGeneration) return false;
    const currentKeys = new Set((this.planLimits.limits("codex") ?? []).map(planLimitKey));
    if (
      !this.codexBackendSummary
      || rateLimits.some(
        (limit) =>
          !limit.limitId?.trim()
          || !currentKeys.has(planLimitKey(limit)),
      )
    ) {
      // A notification that arrived while this one waited merges after the
      // snapshot in the queue. A reading recorded during the read makes the
      // snapshot unordered, and the store still merges it forward.
      return await this.refetchCodexRateLimits({ backendGeneration, accountKey });
    }
    // Each running turn reports the limits its own request saw, and those
    // requests finish in any order, so a rolling update can be older than
    // what is shown. It is still a fresh observation of the account, even
    // when its values match what is held.
    return this.planLimits.record("codex", {
      limits: rateLimits,
      precise: true,
      dated: true,
      account: accountKey,
      describe: describeCodexRateLimit,
    });
  }

  private async refreshCodexQuotas(): Promise<void> {
    // Quota reads must not launch discovery or persist provider observations.
    // A failed startup thread read can leave only the selected executable's
    // projection. It still authorizes account reads on that selected runtime.
    if (this.closed || !this.codexOpenAiProviderEnabled || !this.readCodexBackendSummary().available) return;
    if (this.codexClient.isAuthenticationRequired?.()) return;
    if (this.codexQuotaRefresh) return await this.codexQuotaRefresh;
    if (
      this.codexQuotaRefreshAt !== undefined
      && Date.now() - this.codexQuotaRefreshAt < 5_000
    ) return;
    this.codexQuotaRefreshAt = Date.now();
    const backendGeneration = this.codexBackendGeneration;
    const work = (async () => {
      // Snapshot the group before reading the account so a concurrent Settings
      // save cannot relabel the quota observation already being requested.
      let usageAccountGroup: string | undefined;
      let accountGroupRead = false;
      try {
        usageAccountGroup = this.resolveUsageAccountGroupsFn().codex;
        accountGroupRead = true;
      } catch {
        // Configuration failures leave attribution unknown without preventing
        // account recovery or quota reads.
      }
      let account: BackendAccountSummary | undefined;
      try {
        account = await readClientAccount(this.codexClient);
      } catch (error) {
        backendRegistryLog.warn("Codex account refresh failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this.closed || backendGeneration !== this.codexBackendGeneration) return;
      const currentSummary = this.readCodexBackendSummary();
      if (isMeaningfulAccountSummary(account)) {
        const previous = currentSummary.account;
        const accountChanged = previous?.type !== account.type
          || previous?.accountId !== account.accountId
          || previous?.email !== account.email
          || previous?.label !== account.label
          || previous?.planType !== account.planType;
        const withoutChatgptQuotas = account.type === "apiKey"
          || (!account.type && typeof account.requiresOpenaiAuth === "boolean");
        this.codexBackendSummary = { ...currentSummary, account };
        if (accountChanged || withoutChatgptQuotas) {
          // A new account or plan has its own allowance; limits start over.
          this.forgetCodexAccountRateLimits();
        }
        if (withoutChatgptQuotas) return;
      } else if (!this.codexBackendSummary) {
        this.codexBackendSummary = currentSummary;
      }
      await this.refetchCodexRateLimits({
        backendGeneration,
        accountKey: accountGroupRead ? usageAccountKey(account, usageAccountGroup) : undefined,
      });
    })();
    this.codexQuotaRefresh = work;
    try {
      await work;
    } finally {
      if (this.codexQuotaRefresh === work) this.codexQuotaRefresh = undefined;
    }
  }

  private async refetchCodexRateLimits(params: {
    backendGeneration: number;
    accountKey: string | undefined;
  }): Promise<boolean> {
    if (this.codexClient.isAuthenticationRequired?.()) return false;
    if (isUnauthenticatedCodexProvider(this.codexBackendSummary?.account)) return false;
    const since = this.planLimits.mark("codex");
    let refetchedRateLimits: BackendRateLimitSummary[];
    try {
      refetchedRateLimits = await readClientRateLimits(this.codexClient);
    } catch (error) {
      backendRegistryLog.warn(
        "Codex rate-limit refresh failed",
        { error: error instanceof Error ? error.message : String(error) },
      );
      return false;
    }
    if (
      this.closed
      || params.backendGeneration !== this.codexBackendGeneration
      || refetchedRateLimits.length === 0
    ) {
      return false;
    }
    // `since` orders the read. Requested after every reading held, it is the
    // newest one and may lower a window: a reset credit clears usage
    // mid-window. Overtaken by a reading recorded during it, it merges
    // unordered, so usage only rises. Requested before an account change
    // cleared the limits, it is dropped.
    const changed = this.planLimits.record("codex", {
      limits: refetchedRateLimits,
      since,
      precise: true,
      dated: true,
      account: params.accountKey,
      describe: describeCodexRateLimit,
    });
    // Before discovery publishes a summary, discovery shows the limits.
    return changed && this.codexBackendSummary !== undefined;
  }

  private async scheduleCodexRateLimitBroadcast(event: AgentEvent): Promise<void> {
    const now = Date.now();
    this.pendingCodexRateLimitBroadcast = event;
    const elapsed = this.codexRateLimitLastBroadcastAt === undefined
      ? CODEX_RATE_LIMIT_BROADCAST_WINDOW_MS
      : now - this.codexRateLimitLastBroadcastAt;
    if (elapsed >= CODEX_RATE_LIMIT_BROADCAST_WINDOW_MS) {
      if (this.codexRateLimitBroadcastTimer) {
        clearTimeout(this.codexRateLimitBroadcastTimer);
        this.codexRateLimitBroadcastTimer = undefined;
      }
      await this.flushPendingCodexRateLimitBroadcast(now);
      return;
    }
    if (this.codexRateLimitBroadcastTimer) {
      return;
    }
    this.codexRateLimitBroadcastTimer = setTimeout(() => {
      this.codexRateLimitBroadcastTimer = undefined;
      void this.flushPendingCodexRateLimitBroadcast().catch((error) => {
        backendRegistryLog.error("Codex rate-limit broadcast failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, CODEX_RATE_LIMIT_BROADCAST_WINDOW_MS - elapsed);
  }

  private async flushPendingCodexRateLimitBroadcast(
    broadcastAt = Date.now(),
  ): Promise<void> {
    const event = this.pendingCodexRateLimitBroadcast;
    this.pendingCodexRateLimitBroadcast = undefined;
    if (!event || this.closed) {
      return;
    }
    this.codexRateLimitLastBroadcastAt = broadcastAt;
    await this.emitToListeners(event);
  }

  /**
   * Stamp `discoveryPending` onto a Codex summary that is unavailable only
   * because discovery has not answered yet.
   *
   * Applied at every return of `readCodexBackendSummary`, including the cached
   * one, so "not selected yet" and "not configured" never read alike to a
   * startup surface deciding whether the profile has a provider at all.
   */
  private withCodexDiscoveryPending(summary: BackendSummary): BackendSummary {
    const pending = !summary.available && this.resolveCodexDiscoveryPendingFn();
    if (pending === Boolean(summary.discoveryPending)) {
      return summary;
    }
    if (pending) {
      return { ...summary, discoveryPending: true };
    }
    const { discoveryPending: _settled, ...settledSummary } = summary;
    return settledSummary;
  }

  private async discoverCodexBackend(
    permit: ProviderDiscoveryPermit,
    observer?: CodexDiscoveryObserver,
  ): Promise<BackendSummary> {
    assertProviderDiscoveryPermit(permit);
    const previousSummary = this.readCodexBackendSummary();
    const backendGeneration = this.codexBackendGeneration;
    const providerRevision = this.codexModelProviderRevision;
    const accountRevision = this.codexAccountRevision;
    const rateLimitsSince = this.planLimits.mark("codex");
    const { lastKnownGood } = this.readCodexProvider();
    const usageAccountGroup = this.resolveUsageAccountGroupsFn().codex;
    const accountRead = this.codexOpenAiProviderEnabled ? readClientAccount(this.codexClient) : Promise.resolve(undefined);
    const [
      initializeResult,
      defaultModelsResult,
      accountResult,
      rateLimitsResult,
      runtimeCommandResult,
    ] = await Promise.allSettled([
      this.codexClient.getInitializeResult().then((result) => {
        observer?.onCodexConnected?.();
        return result;
      }),
      this.readCodexDefaultModelsOnce("backend-summary"),
      accountRead,
      accountRead.catch(() => undefined).then((account) =>
        !this.codexOpenAiProviderEnabled || isUnauthenticatedCodexProvider(account) ? [] : readClientRateLimits(this.codexClient)
      ),
      this.resolveCodexRuntimeCommandFn?.(),
    ]);
    if (backendGeneration !== this.codexBackendGeneration) {
      return this.readCodexBackendSummary();
    }
    // Resolution rejects when nothing is selected yet; the durable observation
    // is then the only thing left that can name a command.
    const runtimeCommand =
      runtimeCommandResult.status === "fulfilled"
        ? runtimeCommandResult.value
        : undefined;
    const successful =
      initializeResult.status === "fulfilled" ? [initializeResult.value] : [];
    const methods = mergeMethods(successful);
    const available = successful.length > 0;
    const discoveredModels = [defaultModelsResult].flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const unavailableReason =
      initializeResult.status === "rejected"
        ? initializeResult.reason instanceof Error
          ? initializeResult.reason.message
          : String(initializeResult.reason)
        : "";
    const modelRefreshError =
      defaultModelsResult.status === "rejected"
        ? defaultModelsResult.reason instanceof Error
          ? defaultModelsResult.reason.message
          : String(defaultModelsResult.reason)
        : "";
    if (previousSummary.available && (!available || modelRefreshError)) {
      // A force refresh can fail because a healthy binary was temporarily
      // unavailable or model listing failed. Keep the current/durable summary
      // and reject so Settings surfaces the attempt without caching a sticky
      // unavailable backend or empty model catalog.
      throw new Error(
        unavailableReason || modelRefreshError || "Codex unavailable",
      );
    }
    // Today's `initialize` carries no `serverInfo` at all; the App Server's
    // version reaches us inside the `userAgent` it does report. The resolved
    // executable stands in when this connection never handshook.
    const serverVersion =
      successful[0]?.serverInfo?.version
      ?? codexVersionFromUserAgent(successful[0]?.userAgent)
      ?? runtimeCommand?.version
      ?? lastKnownGood?.selectedVersion;
    const capabilities = buildCapabilities(methods, "codex", serverVersion);

    // Runtime metadata still applies after an account transition. Its older
    // account reply must not replace the refreshed account state. Its quota
    // reply is ordered by `rateLimitsSince`, which an account change voids.
    const accountChangedDuringDiscovery = accountRevision !== this.codexAccountRevision;
    const discoveredRateLimits =
      rateLimitsResult.status === "fulfilled"
        ? rateLimitsResult.value
        : undefined;
    const summary: BackendSummary = {
      kind: "codex",
      label: BACKEND_LABELS.codex,
      available,
      account:
        accountChangedDuringDiscovery
          ? this.codexBackendSummary?.account
          : accountResult.status === "fulfilled"
            && isMeaningfulAccountSummary(accountResult.value)
            ? accountResult.value
            : undefined,
      serverName: successful[0]?.serverInfo?.name,
      serverVersion,
      runtimeBuild: codexRuntimeBuild(
        runtimeCommand?.command ?? lastKnownGood?.selectedCommand,
      ),
      methods,
      capabilities,
      launchpadOptions: this.buildCodexLaunchpadOptions(discoveredModels),
      ...this.codexModelProviderCatalogStates(),
      executionModes: [
        {
          mode: "default",
          label: EXECUTION_MODE_SUMMARIES.default.label,
          available,
          isDefault: true,
          unavailableReason:
            initializeResult.status === "rejected"
              ? initializeResult.reason instanceof Error
                ? initializeResult.reason.message
                : String(initializeResult.reason)
              : undefined,
        },
        codexAutoExecutionMode(
          available,
          successful[0]?.serverInfo?.version
            ?? codexVersionFromUserAgent(successful[0]?.userAgent)
            ?? runtimeCommand?.version
            ?? lastKnownGood?.selectedVersion,
        ),
        {
          mode: "full-access",
          label: EXECUTION_MODE_SUMMARIES["full-access"].label,
          available,
          unavailableReason:
            initializeResult.status === "rejected"
              ? initializeResult.reason instanceof Error
                ? initializeResult.reason.message
                : String(initializeResult.reason)
              : undefined,
        },
      ],
      unavailableReason: available ? undefined : unavailableReason || "Codex unavailable",
    };
    this.codexBackendSummary = summary;
    if (discoveredRateLimits?.length) {
      // Readings that landed during discovery (rolling updates, a quota
      // refresh) may be newer than this read; the store orders them.
      this.planLimits.record("codex", {
        limits: discoveredRateLimits,
        since: rateLimitsSince,
        precise: true,
        dated: true,
        account: usageAccountKey(summary.account, usageAccountGroup),
        describe: describeCodexRateLimit,
      });
    } else if (discoveredRateLimits && this.planLimits.mark("codex") === rateLimitsSince) {
      // The newest read reports no limits: the account has none.
      this.planLimits.clear("codex");
    }
    if (providerRevision !== this.codexModelProviderRevision) {
      // The provider list changed while this discovery read models, so its
      // models describe the old list. Its publication found no summary to
      // refresh; read again now that there is one.
      await this.refreshCodexProviderCatalogs().catch(async (error: unknown) => {
        backendRegistryLog.warn("Codex model provider refresh after discovery failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.publishKnownCodexProviderModels(this.codexModelProviderRevision);
      });
      return this.readCodexBackendSummary();
    }
    return this.codexSummaryWithLimits(summary);
  }

  private async withCodexThreadClient<T>(
    threadId: string,
    operation: (client: BackendClient, mode: ThreadExecutionMode) => Promise<T>,
    requestedMode?: ThreadExecutionMode,
    // Whether to emit the routing diagnostic. Reads (readThread) are
    // execution-mode-agnostic and get called once per thread by content
    // search, so they opt out — otherwise a single thread search spews one
    // routing line per thread. Turn/execution paths keep it on (the #203
    // security cross-check in messaging-controller relies on it).
    logRouting = true,
  ): Promise<T> {
    if (
      this.codexRuntimeSupervisor.runtimeRestartPending
      || this.codexRuntimeSupervisor.runtimeRestartPromise
    ) {
      await this.codexRuntimeSupervisor.maybeRestartCodexForManagedRuntimeChange();
    }
    // Single-client passthrough. The mode passed to the operation is no
    // longer a routing decision — it's documentation for callers that
    // want to forward it to codex's per-turn approvalPolicy/sandboxPolicy
    // override on turn/start (PR #213). The cross-mode try/fallback
    // logic is gone because there is no second process to fall back to.
    let mode: ThreadExecutionMode;
    let source: "explicit" | "overlay" | "default-fallback";
    if (requestedMode) {
      mode = requestedMode;
      source = "explicit";
    } else {
      const overlay = await this.overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId,
      });
      if (overlay?.executionMode) {
        mode = overlay.executionMode;
        source = "overlay";
      } else {
        mode = "default";
        source = "default-fallback";
      }
    }
    if (logRouting) {
      backendRegistryLog.debug("codex thread client routing", {
        threadId,
        requestedMode,
        resolvedMode: mode,
        source,
      });
    }
    return await operation(this.codexClient, mode);
  }

  private nativeVoiceLeases = 0;
  // Live voice sessions watch their thread's tool calls so the operator sees
  // what a delegation did. Empty unless a voice session is open.
  private readonly nativeVoiceToolListeners = new Set<(call: NativeVoiceToolCall) => void>();

  async nativeVoiceCapability(): Promise<NativeVoiceCapability> {
    const result = await this.codexClient.getInitializeResult();
    return supportsNativeVoice(result.userAgent)
      ? { available: true }
      : { available: false, reason: "Live voice requires Codex 0.159 or newer with experimental WebRTC support. Update the Codex runtime in Settings." };
  }

  async acquireNativeVoiceBackend(threadId: string): Promise<NativeVoiceBackend> {
    await this.threadDirectoryService.withCodexEnvironmentRuntimeLock("codex", threadId, async () => {});
    return await this.serializeCodexAgentChange(threadId, async () => {
      return await this.withActiveCodexThreadClient(threadId, async (client, mode) => {
        const capability = await this.nativeVoiceCapability();
        if (!capability.available) throw new Error(capability.reason);
        if (!client.startRealtime || !client.stopRealtime || !client.appendRealtimeText
          || !client.onRealtimeEvent || !client.onRealtimeDisconnect) {
          throw new Error("This backend does not support live voice.");
        }
        // A running coding task already owns the loaded thread and catalog.
        // Ordinary idle threads need current-process proof or catalog refresh.
        // The remembered director can restore its PwrAgent-created catalog;
        // its discovery tool resolves current definitions at dispatch time.
        const running = this.threadHasActiveTurn(threadId);
        const ownsReservation = !this.context.turnState.hasStartReservation(threadId);
        const voiceReservation = ownsReservation ? this.context.turnState.reserveStart(threadId, "voice") : undefined;
        try {
          if (!running) {
            const overlay = await this.overlayStore.getThreadOverlayState({ backend: "codex", threadId });
            const cwd = await this.resolveThreadEnvironmentCwd("codex", threadId, overlay);
            const settings = await this.resolveModelSettings("codex", {
              model: overlay?.model,
              reasoningEffort: overlay?.reasoningEffort,
              serviceTier: overlay?.serviceTier,
              fastMode: overlay?.fastMode,
            });
            const modeSettings = executionModeSettings(mode);
            const admission = {
              threadId, ...settings,
              ...(cwd ? { cwd } : {}),
              codexEnvironmentRuntime: overlay?.codexEnvironmentRuntime,
              approvalPolicy: modeSettings.approvalPolicy,
              approvalsReviewer: modeSettings.approvalsReviewer,
              sandbox: modeSettings.sandbox,
              defaultModeRequestUserInput: this.resolveCodexDefaultModeRequestUserInputFn(),
            };
            // A newly created director has the ordinary discovery catalog.
            // Eager director tools are a latency optimization, not authority.
            const initialTools = await this.buildCodexParentDynamicTools(
              this.resolveTokenMiserEnabledForOverride(overlay?.tokenMiserEnabled),
            );
            const fresh = await client.prepareFreshNativeVoiceThread?.({ ...admission, dynamicTools: initialTools });
            if (!fresh) {
              const manager = this.overlayStore.getVoiceManagerThread?.();
              if (manager?.backend === "codex" && manager.threadId === threadId
                && !overlay?.codexEnvironmentRuntime
                && client.resumeNativeVoiceThread
                && !(await this.supportsTokenMiserDynamicToolsResume(client))) {
                // Stock resume restores creation-time tools across restarts.
                // Do not manufacture current-catalog proof from this result.
                // Custom execution environments still need verified refresh.
                await client.resumeNativeVoiceThread(admission);
              } else {
                const dynamicTools = await this.requireCodexAgentRefreshTools(client, threadId, overlay, true);
                await client.refreshThreadTools!({ ...admission, dynamicTools });
              }
            }
          }
          this.nativeVoiceLeases += 1;
          let released = false;
          return {
            start: client.startRealtime.bind(client),
            stop: client.stopRealtime.bind(client),
            text: client.appendRealtimeText.bind(client),
            onEvent: (listener) => client.onRealtimeEvent!(listener, threadId),
            onDisconnect: (listener) => client.onRealtimeDisconnect!(listener, threadId),
            onToolCall: (listener) => {
              this.nativeVoiceToolListeners.add(listener);
              return () => { this.nativeVoiceToolListeners.delete(listener); };
            },
            release: () => {
              if (released) return;
              released = true;
              this.nativeVoiceLeases -= 1;
              if (this.nativeVoiceLeases === 0) this.codexRuntimeSupervisor.maybeDrainCodexInvalidIdRecoveries();
            },
          };
        } finally {
          if (ownsReservation) this.context.turnState.releaseStart(threadId, voiceReservation);
          this.codexRuntimeSupervisor.maybeDrainCodexInvalidIdRecoveries();
          if (ownsReservation && !this.threadHasActiveTurn(threadId)
            && this.threadTurnQueue.getQueuedEntries({ backend: "codex", threadId }).length > 0) {
            void this.threadTurnQueue.releaseThread({ backend: "codex", threadId, status: "voice_catalog_ready" });
          }
        }
      });
    });
  }

  private async withActiveCodexThreadClient<T>(
    threadId: string,
    operation: (client: BackendClient, mode: ThreadExecutionMode) => Promise<T>,
  ): Promise<T> {
    const activeMode = this.findActiveCodexThreadMode(threadId);
    if (activeMode) {
      return await operation(this.getClient("codex", activeMode), activeMode);
    }

    return await this.withCodexThreadClient(threadId, operation);
  }

  private findActiveCodexThreadMode(threadId: string): ThreadExecutionMode | undefined {
    const keyPrefix = `${threadId}:`;
    const modes = new Set<ThreadExecutionMode>();
    for (const [key, mode] of this.context.turnState.executionEntries()) {
      if (key.startsWith(keyPrefix)) {
        modes.add(mode);
      }
    }

    return modes.size === 1 ? [...modes][0] : undefined;
  }

  auditArchivedCheckouts(onProgress?: (progress: MaintenanceDiscoveryProgress) => void): Promise<{
    candidates: Array<{ backend: AppServerBackendKind; threadId: string; worktreePath: string }>;
    kept: Record<string, number>;
    emptyFolders: number;
    unreferenced: string[];
    unreferencedUnavailable?: string;
    unreferencedTruncated?: boolean;
    inventory?: ArchivedWorktreeRepairReport["inventory"];
  }> {
    return this.threadArchiveCoordinator.auditArchivedCheckouts(onProgress);
  }

  /** Legacy callers cannot turn an unidentified folder into a removal. */
  async removeUnreferencedCheckouts(worktreePaths: string[]): Promise<{
    removed: { worktreePath: string }[];
    kept: { worktreePath: string; reason: string }[];
    failed: { worktreePath: string; message: string }[];
  }> {
    return { removed: [], failed: [], kept: [...new Set(worktreePaths)].map((worktreePath) => ({
      worktreePath, reason: "No identified thread owns this checkout",
    })) };
  }

  removeArchivedCheckouts(selection: { worktreePaths: string[]; emptyFolders: boolean;
    /** Reviewed approvals to snapshot an over-limit checkout, by path. */
    snapshotLimits?: { worktreePath: string; bytes: number }[];
    /** The operator's approvals to unlock someone else's lock, by checkout, with the lock text they saw. */
    unlockApprovals?: { worktreePath: string; lockReason: string }[] }, options?: {
    onItem: (item: Pick<ThreadMaintenanceRunItem, "status" | "stage" | "reason" | "detail" | "lockReason"> & { path: string }) => void;
    stopped: () => boolean;
  }): Promise<{
    removed: { worktreePath: string }[];
    kept: { worktreePath: string; reason: string; lock?: WorktreeLockedKept }[];
    failed: { worktreePath: string; message: string }[];
    emptyFoldersRemoved: number;
    emptyFoldersFailed: { worktreePath: string; message: string }[];
  }> {
    return this.threadArchiveCoordinator.removeArchivedCheckouts(selection, options);
  }

  approveReviewedSnapshotLimit(backend: AppServerBackendKind, threadId: string, bytes: number): void {
    return this.threadArchiveCoordinator.approveReviewedSnapshotLimit(backend, threadId, bytes);
  }

  clearReviewedSnapshotLimit(backend: AppServerBackendKind, threadId: string): void {
    return this.threadArchiveCoordinator.clearReviewedSnapshotLimit(backend, threadId);
  }

  getThreadArchivePolicy(): DesktopThreadArchivePolicy {
    return this.threadArchiveCoordinator.getThreadArchivePolicy();
  }

  refreshArchiveCandidate(candidate: ThreadArchiveCandidate): Promise<ThreadArchiveCandidate> {
    return this.threadArchiveCoordinator.refreshArchiveCandidate(candidate);
  }

  isArchiveCandidateBusy(candidate: ThreadArchiveCandidate): boolean {
    return this.threadArchiveCoordinator.isArchiveCandidateBusy(candidate);
  }

  getCheckoutHibernationPolicy(): DesktopCheckoutHibernationPolicy {
    return this.threadArchiveCoordinator.getCheckoutHibernationPolicy();
  }

  checkoutHibernationKeepReason(
    candidate: ThreadArchiveCandidate,
    candidates: readonly ThreadArchiveCandidate[],
    policy: DesktopCheckoutHibernationPolicy,
    now: number,
    owners: CheckoutPathOwners = new CheckoutPathOwners(candidates),
  ): { target?: string; keep?: string } {
    return this.threadArchiveCoordinator.checkoutHibernationKeepReason(candidate, candidates, policy, now, owners);
  }

  hibernateReviewedCheckout(candidate: ThreadArchiveCandidate, policy: DesktopCheckoutHibernationPolicy,
    onStage?: (stage: ThreadMaintenanceRunStage) => void): Promise<boolean | string> {
    return this.threadArchiveCoordinator.hibernateReviewedCheckout(candidate, policy, onStage);
  }

  /**
   * One thread's row.
   *
   * `freshness` is the caller's declaration, not an optimization hint:
   *
   * - `"provider"` (the default) walks the provider's whole thread list and
   *   picks the row out of it. A caller about to mutate a workspace needs the
   *   provider's current truth, and pays for it.
   * - `"last-known"` answers from the thread information store, which survives
   *   list-cache invalidation. A read-only caller asking where a thread's
   *   workspace is does not need a fresh collection, and making it pay for one
   *   put a full paged provider walk on every turn boundary: `turn/started`
   *   invalidates the list cache, and the next branch adoption rebuilt the
   *   entire list to read one row.
   *
   * A `"last-known"` read falls back to the provider walk when the thread has
   * never been observed at the enrichment level the caller listed at, so a cold
   * process still answers correctly — it just stops re-answering.
   */
  private async findThreadForWorkspaceHandoff(params: {
    backend: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    freshness?: "last-known" | "provider";
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined> {
    const callerReason = params.callerReason ?? "workspace-handoff";
    if (params.freshness === "last-known") {
      const remembered = this.threadInfoStore.getSummary(
        { backend: params.backend, threadId: params.threadId },
        { requireEnriched: shouldEnrichThreadDirectories(callerReason) },
      );
      if (remembered) {
        return remembered;
      }
    }
    return await this.listThreads({
      backend: params.backend,
      archived: false,
      callerReason,
    })
      .then((threads) => threads.find((thread) => thread.id === params.threadId))
      .catch(() => undefined);
  }

  private async resolveThreadEnvironmentCwd(
    backend: AppServerBackendKind,
    threadId: string,
    overlay?: ThreadOverlayState,
  ): Promise<string | undefined> {
    const pendingThread = this.pendingStartedThreads.get(
      buildThreadIdentityKey(backend, threadId),
    );
    if (pendingThread) {
      const pendingCwd = resolveThreadWorkspaceCwd(
        pendingThread,
        overlay?.extraLinkedDirectories,
      );
      if (pendingCwd?.trim()) {
        return pendingCwd.trim();
      }
    }

    const thread = await this.findThreadForWorkspaceHandoff({
      backend,
      callerReason: "turn-cwd",
      freshness: "last-known",
      threadId,
    });
    const threadCwd = resolveThreadWorkspaceCwd(
      thread,
      overlay?.extraLinkedDirectories,
    );
    if (threadCwd?.trim()) {
      return threadCwd.trim();
    }

    return resolveLinkedDirectoryWorkspaceCwd(overlay?.extraLinkedDirectories)?.trim() ||
      undefined;
  }

  private async recordCodexWorktreeOwnerThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    worktreePath?: string;
  }): Promise<void> {
    const worktreePath = params.worktreePath?.trim();
    if (params.backend !== "codex" || !worktreePath) {
      return;
    }

    try {
      await this.gitDirectoryService.recordCodexWorktreeOwnerThread({
        worktreePath,
        threadId: params.threadId,
      });
    } catch (error) {
      backendRegistryLog.warn("failed to record Codex worktree owner thread", {
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
        worktreePath,
      });
    }
  }

  private async renameWithClient(
    client: BackendClient,
    threadId: string,
    name: string,
  ): Promise<{ threadId: string }> {
    if (!client.renameThread) {
      throw new Error("Selected backend does not support thread renaming");
    }

    return await client.renameThread({ threadId, name });
  }

  private async updateThreadGitBranchMetadata(params: {
    backend: AppServerBackendKind;
    branch?: string;
    threadId: string;
  }): Promise<void> {
    const branch = params.branch?.trim();
    if (!branch) {
      return;
    }

    const updateWithClient = async (client: BackendClient): Promise<void> => {
      if (!client.updateThreadMetadata) {
        return;
      }

      await client.updateThreadMetadata({
        threadId: params.threadId,
        gitInfo: {
          branch,
        },
      });
    };

    try {
      if (params.backend === "codex") {
        await this.withCodexThreadClient(params.threadId, async (client) => {
          await updateWithClient(client);
        });
      }
    } catch (error) {
      backendRegistryLog.warn("thread git metadata update failed after handoff", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
      });
    }
  }

  /**
   * Resolves once no missing-thread work is in flight: every pending workspace
   * CWD synchronization has settled — that rejection is what records a missing
   * thread and arms the audit — and any running audit has finished.
   *
   * This exists because the work is deliberately fire-and-forget, so nothing a
   * caller awaits tells it when the audit has run. A test that instead pumped
   * fake timers for a fixed number of ticks was guessing how many awaited hops
   * the archive path takes; that count differs by platform, and the Windows job
   * flaked on it (#1793). Loop rather than assume one pass drains everything:
   * the audit archives through `listThreads`, which can schedule further
   * synchronizations. The bound is a runaway guard — reaching it means
   * something is re-arming without converging, which is a bug worth seeing.
   */
  async whenMissingCodexThreadWorkSettledForTests(): Promise<void> {
    for (let pass = 0; pass < 10; pass += 1) {
      const pendingSyncs = [...this.threadWorkspaceService.pendingCodexWorkspaceCwdSyncRecords.values()];
      const evaluation = this.missingCodexThreadEvaluation;
      if (pendingSyncs.length === 0 && !evaluation) {
        return;
      }
      await Promise.all(pendingSyncs.map((pending) => pending.promise));
      await evaluation;
    }
  }

  /**
   * Resolves once no thread-title generation is in flight. Generation is
   * fire-and-forget, so nothing a caller awaits says when the title has been
   * applied. It reads the thread listing, which probes each workspace's
   * `.codex/environments` on the host filesystem, so a test that counted
   * event-loop turns instead raced that I/O. Loop because a finished
   * generation can be followed by another admitted from its title event.
   */
  async whenThreadTitleGenerationSettledForTests(): Promise<void> {
    await this.threadTitles.whenSettled();
  }

  /**
   * Resolves once no queued execution-mode change is being applied. Turn end
   * applies the queue fire-and-forget, so nothing a caller awaits says when
   * the codex call, overlay flip, and transition log have landed. Loop
   * because one flush can be followed by another; the bound is a runaway
   * guard.
   */
  async whenQueuedExecutionModeFlushesSettledForTests(): Promise<void> {
    for (let pass = 0; pass < 10; pass += 1) {
      const flushes = [...this.queuedExecutionModeFlushes.values()];
      if (flushes.length === 0) {
        return;
      }
      await Promise.allSettled(flushes);
    }
  }

  private isCodexThreadKnownMissing(threadId: string): boolean {
    return this.missingCodexThreadIds.has(threadId);
  }

  private clearMissingCodexThread(threadId: string): void {
    this.missingCodexThreadIds.delete(threadId);
    this.unresolvedMissingCodexThreadIds.delete(threadId);
  }

  /**
   * Records the visible Codex thread count for the operator notice.
   * Only the full `thread/list` path may call this.
   */
  private recordCodexVisibleThreadCount(count: number): void {
    this.codexVisibleThreadCount = count;
  }

  private recordMissingCodexThread(threadId: string): void {
    // Only a thread that is newly missing needs a decision. Re-recording an
    // already-decided thread would re-open a prompt the operator answered.
    if (this.missingCodexThreadIds.has(threadId)) {
      return;
    }
    this.missingCodexThreadIds.add(threadId);
    this.unresolvedMissingCodexThreadIds.add(threadId);
    backendRegistryLog.warn(
      "Codex reports thread missing; suspending thread-scoped retries",
      { threadId },
    );
    this.scheduleMissingCodexThreadAudit();
  }

  private scheduleMissingCodexThreadAudit(): void {
    if (
      this.closed
      || this.missingCodexThreadEvaluationTimer
      || this.missingCodexThreadEvaluation
    ) {
      return;
    }
    this.missingCodexThreadEvaluationTimer = setTimeout(() => {
      this.missingCodexThreadEvaluationTimer = undefined;
      this.missingCodexThreadEvaluation = this.auditMissingCodexThreads()
        .catch((error) => {
          backendRegistryLog.error("Codex missing-thread audit failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.missingCodexThreadEvaluation = undefined;
        });
    }, CODEX_MISSING_THREAD_EVALUATION_DELAY_MS);
    this.missingCodexThreadEvaluationTimer.unref?.();
  }

  private async auditMissingCodexThreads(): Promise<void> {
    if (this.closed) {
      return;
    }
    const threadIds = [...this.unresolvedMissingCodexThreadIds];
    if (threadIds.length === 0) {
      return;
    }

    // A workspace settings error can mean the thread is not loaded, rather
    // than absent from durable storage. In particular, handoff has already
    // committed the destination before its background synchronization runs.
    // Never turn that error into an archive or worktree cleanup automatically,
    // even when only one thread in a large profile is affected.
    const totalCount = Math.max(this.codexVisibleThreadCount, threadIds.length);
    backendRegistryLog.warn(
      "Codex missing threads need an operator decision",
      {
        missingCount: threadIds.length,
        totalCount,
        threadIds,
      },
    );
    await this.emitCodexMissingThreadsUpdate({
      missingCount: threadIds.length,
      profileName: this.resolveMissingCodexThreadProfileName(),
      status: "confirmationRequired",
      threadIds,
      totalCount,
    });
  }

  private async archiveMissingCodexThreads(threadIds: string[]): Promise<{
    archived: string[];
    failed: string[];
    failures: { threadId: string; error: string }[];
  }> {
    const archived: string[] = [];
    const failed: string[] = [];
    const failures: { threadId: string; error: string }[] = [];
    for (const threadId of threadIds) {
      this.unresolvedMissingCodexThreadIds.delete(threadId);
      try {
        // `archiveThread` recognizes `thread not found` as an already-missing
        // thread, so this performs the local tombstone plus the worktree,
        // messaging, and child cleanup instead of failing on Codex's rejection.
        await this.archiveThread({ backend: "codex", threadId });
        archived.push(threadId);
      } catch (error) {
        failed.push(threadId);
        const failure = {
          error: error instanceof Error ? error.message : String(error),
          threadId,
        };
        failures.push(failure);
        backendRegistryLog.warn("archiving a missing Codex thread failed", failure);
      }
    }
    if (archived.length > 0) {
      this.invalidateThreadListCache("codex");
    }
    if (archived.length > 0 || failed.length > 0) {
      backendRegistryLog.warn("archived Codex threads reported missing", {
        archivedCount: archived.length,
        failedCount: failed.length,
      });
    }
    return { archived, failed, failures };
  }

  /**
   * Applies the operator's answer to a missing-thread confirmation prompt.
   * `keep` leaves the threads in place and suppresses both the prompt and the
   * thread-scoped retries for the rest of this session; a reconnected Codex
   * profile clears the suppression on the first successful thread-scoped
   * write, and a restart re-asks if the threads are still missing.
   */
  async resolveMissingCodexThreads(
    request: ResolveMissingCodexThreadsRequest,
  ): Promise<ResolveMissingCodexThreadsResponse> {
    // Every subscribed window renders the same prompt, so the answer can
    // arrive more than once. Claiming the ids here makes the second answer a
    // no-op instead of a second pass of worktree and messaging cleanup.
    const threadIds = request.threadIds.filter(
      (threadId) =>
        threadId.trim()
        && this.unresolvedMissingCodexThreadIds.delete(threadId),
    );
    if (request.action === "keep") {
      // The ids stay in `missingCodexThreadIds`, which is what keeps the
      // thread visible and its retries suspended.
      backendRegistryLog.warn("keeping Codex threads reported missing", {
        threadCount: threadIds.length,
      });
      return { action: "keep", archivedThreadIds: [], failedThreadIds: [] };
    }

    const result = await this.archiveMissingCodexThreads(threadIds);
    return {
      action: "archive",
      archivedThreadIds: result.archived,
      failedThreadIds: result.failed,
    };
  }

  private resolveMissingCodexThreadProfileName(): string {
    try {
      return resolveActiveProfileName();
    } catch {
      // The prompt names the profile only to help the operator recognize a
      // Codex profile mismatch. It stays useful without the name.
      return "default";
    }
  }

  private async emitCodexMissingThreadsUpdate(
    params: Extract<
      AppServerNotification,
      { method: "codex/missingThreads/updated" }
    >["params"],
  ): Promise<void> {
    try {
      await this.emit({
        backend: "codex",
        notification: {
          method: "codex/missingThreads/updated",
          params,
        },
      });
    } catch (error) {
      backendRegistryLog.warn("Codex missing-thread notification failed", {
        error: error instanceof Error ? error.message : String(error),
        status: params.status,
      });
    }
  }

  private scheduleThreadTitleGeneration(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
  }): void {
    this.threadTitles.schedule(params);
  }

  private schedulePendingThreadTitleGenerationFromLifecycle(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): void {
    this.threadTitles.schedulePending(params);
  }

  private readonly threadTitles = new ThreadTitleLifecycle(this.threadNaming, {
    canGenerateTitle: (backend) => Boolean(this.threadTitleGenerationService
      && (!this.threadTitleGenerationService.canGenerateTitle || this.threadTitleGenerationService.canGenerateTitle(backend))),
    generateTitle: async (params) => {
      this.assertThreadOwnership();
      return await this.threadTitleGenerationService?.generateTitle(params);
    },
    readTitle: async (identity) => await this.findThreadForTitleGeneration(identity),
    prepareHelper: async ({ backend, threadId }) => {
      const runtime = await this.resolveTitleHelperRuntime({ backend, threadId });
      await this.safePersistTitleHelperSubAgent({
        backend, threadId, status: "running", reason: "Generating a title.",
        ...(runtime.model ? { model: runtime.model } : {}),
        ...(runtime.reasoningEffort ? { reasoningEffort: runtime.reasoningEffort } : {}),
      });
    },
    persistHelper: async ({ existingOnly, ...params }) => {
      if (existingOnly) await this.safePersistExistingTitleHelperSubAgent(params);
      else await this.safePersistTitleHelperSubAgent(params);
    },
    log: (status, params, reason, details) => this.logThreadTitleGeneration(status, params, reason, {
      ...(details?.eligibility ? buildTitleEligibilityLogDetails(details.thread, params.prompt) : {}),
      ...(details?.promptTitle ? { promptTitle: truncateLogValue(shortenDerivedThreadTitle(params.prompt) ?? params.prompt) } : {}),
      ...(details?.generatedTitle !== undefined ? { generatedTitle: truncateLogValue(details.generatedTitle) } : {}),
      ...(details?.cachedTokens !== undefined ? { cachedTokens: details.cachedTokens } : {}),
    }),
  });

  private async safePersistTitleHelperSubAgent(params: {
    backend: AppServerBackendKind;
    threadId: string;
    result?: ThreadTitleHelperResult;
    status: "pending" | "running" | "success" | "failed" | "cancelled";
    model?: string;
    reasoningEffort?: string;
    reason?: string;
  }): Promise<void> {
    try {
      await this.persistTitleHelperSubAgent(params);
    } catch (error) {
      backendRegistryLog.warn("threadTitleHelperSubAgentPersistence", {
        backend: params.backend,
        threadId: params.threadId,
        status: params.status,
        reason: params.reason ?? null,
        persistenceError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async safePersistExistingTitleHelperSubAgent(params: {
    backend: AppServerBackendKind;
    threadId: string;
    result?: ThreadTitleHelperResult;
    status: "running" | "success" | "failed" | "cancelled";
    model?: string;
    reasoningEffort?: string;
    reason?: string;
  }): Promise<void> {
    try {
      const monitorId = titleHelperSubAgentId(params.backend, params.threadId);
      if (!await this.overlayStore.getThreadSubAgent({
        backend: params.backend,
        threadId: params.threadId,
        monitorId,
      })) {
        return;
      }
    } catch (error) {
      backendRegistryLog.warn("threadTitleHelperSubAgentLookup", {
        backend: params.backend,
        threadId: params.threadId,
        status: params.status,
        reason: params.reason ?? null,
        lookupError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    await this.safePersistTitleHelperSubAgent(params);
  }

  private async persistTitleHelperSubAgent(params: {
    backend: AppServerBackendKind;
    threadId: string;
    result?: ThreadTitleHelperResult;
    status: "pending" | "running" | "success" | "failed" | "cancelled";
    model?: string;
    reasoningEffort?: string;
    reason?: string;
  }): Promise<void> {
    const now = Date.now();
    const monitorId = titleHelperSubAgentId(params.backend, params.threadId);
    const existing = await this.overlayStore.getThreadSubAgent({
      backend: params.backend,
      threadId: params.threadId,
      monitorId,
    });
    const usageSnapshot = params.result?.tokenUsage
      ? buildTaskMonitorUsageSnapshot({
          model: params.result.model,
          serviceTier: params.result.serviceTier,
          tokenUsage: params.result.tokenUsage,
        })
      : undefined;
    const preferredModel =
      params.result?.model ?? params.model ?? existing?.preferredModel;
    const preferredReasoningEffort =
      params.result?.reasoningEffort ??
      params.reasoningEffort ??
      existing?.preferredReasoningEffort;
    const terminal =
      params.status === "success" ||
      params.status === "failed" ||
      params.status === "cancelled";
    const startsNewAttempt =
      (params.status === "pending" || params.status === "running")
      && existing !== undefined
      && (
        existing.completedAt !== undefined
        || existing.outcome !== undefined
        || existing.completionSource !== undefined
        || codexNativeSubAgentIsTerminal(existing.status)
        || existing.status === "failed"
      );
    const outcome =
      params.status === "success"
        ? "success"
        : params.status === "failed"
          ? "failure"
          : params.status === "cancelled"
            ? "cancelled"
            : undefined;
    const subAgent: ThreadSubAgentSummary = {
      monitorId,
      task: "Name this thread",
      attemptId: startsNewAttempt || !existing ? randomUUID() : existing.attemptId,
      status: params.status,
      createdAt: startsNewAttempt ? now : existing?.createdAt ?? now,
      updatedAt: now,
      ownerRuntimeInstanceId: startsNewAttempt
        ? this.runtimeInstanceId
        : existing?.ownerRuntimeInstanceId ?? this.runtimeInstanceId,
      ownerRegistrySessionId: startsNewAttempt
        ? this.registrySessionId
        : existing?.ownerRegistrySessionId ?? this.registrySessionId,
      backend: params.backend,
      agentName: "PwrAgent",
      ...(preferredModel ? { preferredModel } : {}),
      ...(preferredReasoningEffort
        ? { preferredReasoningEffort }
        : {}),
      ...(params.result?.helperThreadId
        ? { monitorThreadId: params.result.helperThreadId }
        : {}),
      ...(params.result?.helperTurnId ? { monitorTurnId: params.result.helperTurnId } : {}),
      lastMessage: titleHelperSubAgentMessage(params),
      ...(outcome ? { outcome } : {}),
      ...(terminal ? { completedAt: now } : {}),
      ...(terminal
        ? {
            completionSource: {
              type: "pwragent_fallback",
              reason: "system_title_helper",
              recoveryAttempted: false,
              terminalStatus:
                params.status === "success"
                  ? "completed"
                  : params.status === "cancelled"
                    ? "cancelled"
                    : "failed",
            },
          }
        : {}),
      ...(usageSnapshot ? { monitorUsage: usageSnapshot } : {}),
    };

    await this.writeSystemHelperSubAgent({
      backend: params.backend,
      threadId: params.threadId,
      subAgent,
      ...(params.result && usageSnapshot
        ? { usage: { result: params.result, snapshot: usageSnapshot } }
        : {}),
    });
  }

  /**
   * Lands a PwrAgent system helper's row on its thread and, when the run
   * reported usage, the run's usage line, which the Pricing rail counts as a
   * system helper by its `system:` monitor id. Remote viewers pick both up
   * through the existing `thread/subAgents/updated` and pricing refreshes.
   */
  private async writeSystemHelperSubAgent(params: {
    backend: AppServerBackendKind;
    threadId: string;
    subAgent: ThreadSubAgentSummary;
    usage?: {
      result: {
        accountKey?: string;
        helperThreadId?: string;
        helperTurnId?: string;
        model?: string;
        serviceTier?: string;
      };
      snapshot: TaskMonitorUsageSnapshot;
    };
  }): Promise<void> {
    await this.overlayStore.upsertThreadSubAgent({
      backend: params.backend,
      threadId: params.threadId,
      subAgent: params.subAgent,
    });
    this.invalidateThreadListCache(params.backend);
    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/subAgents/updated",
        params: {
          threadId: params.threadId,
        },
      },
    });
    const usage = params.usage;
    if (
      usage?.result.helperThreadId &&
      typeof this.overlayStore.upsertThreadUsageLine === "function"
    ) {
      const line = buildTaskMonitorUsageLine({
        backend: params.backend,
        accountKey: usage.result.accountKey,
        model: usage.result.model,
        monitorId: params.subAgent.monitorId,
        monitorThreadId: usage.result.helperThreadId,
        monitorTurnId: usage.result.helperTurnId,
        parentThreadId: params.threadId,
        serviceTier: usage.result.serviceTier,
        source: "monitor",
        usage: usage.snapshot,
      });
      logUnpricedThreadUsageLine(line);
      await this.overlayStore.upsertThreadUsageLine({ line });
      await this.threadUsageLedger.emitThreadPricingUpdated({
        backend: params.backend,
        threadId: line.parentThreadId ?? line.threadId,
      });
    }
  }

  private async resolveTitleHelperRuntime(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<{ model?: string; reasoningEffort?: string }> {
    if (params.backend === "codex") {
      // The same resolution the title turn makes, so the sub-agent record
      // never names a model that did not run.
      const selection = await this.codexClient.resolveHelperModelSelection?.({
        helper: "thread_titles",
      });
      return {
        ...(selection?.model ? { model: selection.model } : {}),
        ...(selection?.reasoningEffort
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      };
    }
    if (!isAcpBackendId(params.backend)) {
      return {};
    }
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    const model =
      session?.acpRuntime?.currentModelId ??
      (typeof session?.acpRuntime?.configValues?.model === "string"
        ? session.acpRuntime.configValues.model
        : undefined);
    const reasoningEffort =
      params.backend === "acp:grok"
        ? GROK_TITLE_HELPER_SESSION_POLICY.reasoningEffort
        : session?.acpRuntime?.reasoningEffort ??
          (typeof session?.acpRuntime?.configValues?.reasoningEffort === "string"
            ? session.acpRuntime.configValues.reasoningEffort
            : typeof session?.acpRuntime?.configValues?.reasoning_effort === "string"
              ? session.acpRuntime.configValues.reasoning_effort
              : undefined);
    return {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }

  private async findThreadForTitleGeneration(params: {
    backend: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined> {
    if (params.backend === "codex" && this.codexClient.readThreadSummary) {
      // Eligibility is checked before and after helper work. Read this identity
      // each time so a late operator rename still cancels generated naming.
      return await this.withCodexThreadClient(params.threadId, async (client) => {
        const thread = await client.readThreadSummary!(params.threadId);
        const metadata = await this.overlayStore.getThreadMetadata?.({ backend: "codex", threadId: params.threadId });
        return thread.archivedAt === undefined ? this.withObservedThreadName({ ...thread, ...projectOwnerThreadTitle(thread, metadata) }) : undefined;
      }).catch(() => undefined);
    }
    const activeThreads = await this.listThreads({
      backend: params.backend,
      archived: false,
      callerReason: params.callerReason ?? "title-generation",
    }).catch(() => []);
    return activeThreads.find((thread) => thread.id === params.threadId);
  }

  private logThreadTitleGeneration(
    status: ThreadTitleGenerationLogStatus,
    params: {
      backend: AppServerBackendKind;
      threadId: string;
    },
    reason?: string,
    details?: Record<string, unknown>,
  ): void {
    const payload = {
      backend: params.backend,
      threadId: params.threadId,
      status,
      reason: reason ?? null,
      ...details,
    };
    if (status === "failed" || status === "invalid" || status === "unavailable") {
      backendRegistryLog.warn("threadTitleGeneration", payload);
      return;
    }
    logDebug("threadTitleGeneration", payload);
  }

  private async handleServerRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const callId = request.method === "item/tool/call"
      && typeof request.params.callId === "string"
        ? request.params.callId.trim()
        : "";
    if (
      !callId
      || !this.isLiveDynamicToolCall(backend, {
        threadId: request.params.threadId,
        turnId: request.params.turnId ?? undefined,
      })
    ) {
      return await this.observeNativeVoiceToolCall(
        backend,
        request,
        this.performServerRequest(backend, request, signal),
      );
    }
    const key = [backend, request.params.threadId, request.params.turnId, callId]
      .join("\u0000");
    const signature = createHash("sha256")
      .update(JSON.stringify({
        namespace: request.params.namespace,
        tool: request.params.tool,
        arguments: request.params.arguments,
      }))
      .digest("hex");
    const accepted = this.acceptedDynamicToolCalls.get(key);
    if (accepted) {
      if (accepted.signature !== signature) {
        backendRegistryLog.warn("rejecting reused dynamic tool call id", {
          backend,
          callId,
          requestId: request.params.requestId,
          threadId: request.params.threadId,
          turnId: request.params.turnId,
        });
        return toDynamicToolResponse({
          ok: false,
          code: "invalid_arguments",
          message: `Dynamic tool call id ${callId} was reused with different arguments.`,
        });
      }
      backendRegistryLog.warn("replaying duplicate dynamic tool call result", {
        backend,
        callId,
        requestId: request.params.requestId,
        threadId: request.params.threadId,
        turnId: request.params.turnId,
      });
      return await accepted.promise;
    }

    const promise = this.performServerRequest(backend, request, signal);
    this.acceptedDynamicToolCalls.set(key, { promise, signature });
    return await this.observeNativeVoiceToolCall(backend, request, promise);
  }

  /** Reports a settled dynamic tool call to open voice sessions; never alters it. */
  private async observeNativeVoiceToolCall(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
    promise: Promise<unknown>,
  ): Promise<unknown> {
    const response = await promise;
    if (backend === "codex" && request.method === "item/tool/call" && this.nativeVoiceToolListeners.size > 0) {
      const call: NativeVoiceToolCall = {
        threadId: request.params.threadId,
        tool: String(request.params.tool),
        ...(typeof request.params.namespace === "string" ? { namespace: request.params.namespace } : {}),
        arguments: request.params.arguments,
        response,
      };
      for (const listener of this.nativeVoiceToolListeners) {
        try { listener(call); } catch (error) {
          backendRegistryLog.warn("voice tool-call listener failed", { error: String(error) });
        }
      }
    }
    return response;
  }

  private async performServerRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // A host that restricts agent tools refuses every other tool here, before
    // any route, so a call the model makes up without an advertisement fails
    // the same way as one for a tool that was never wired.
    const agentToolAllowlist = localAgentToolAllowlist();
    if (
      agentToolAllowlist
      && request.method === "item/tool/call"
      && !isAgentToolCallAllowed(agentToolAllowlist, {
        namespace: request.params.namespace,
        tool: request.params.tool,
      })
    ) {
      backendRegistryLog.warn("refusing agent tool outside the host allowlist", {
        backend,
        namespace: typeof request.params.namespace === "string" ? request.params.namespace : null,
        threadId: request.params.threadId,
        tool: typeof request.params.tool === "string" ? request.params.tool : null,
      });
      return toDynamicToolResponse({
        ok: false,
        code: "forbidden",
        message: "This contained member does not allow this PwrAgent tool.",
      });
    }
    if (isAcpBackendId(backend) && isAcpPermissionRequest(request)) {
      const session = this.acpBackend.getSession(backend, request.params.threadId);
      const runtimeCapabilities =
        this.acpBackend.getInstalledAgent(backend)?.runtimeCapabilities;
      const runtimeControlsExecutionMode = acpRuntimeHasExecutionModeSelection({
        registryId: this.acpBackend.getInstalledAgent(backend)?.registryId,
        runtime: session?.acpRuntime,
        runtimeCapabilities,
      });
      const runtimeRequiresFullAccess = acpRuntimeStateRequiresFullAccess({
        runtime: session?.acpRuntime,
        runtimeCapabilities,
      });
      if (
        runtimeControlsExecutionMode
          ? runtimeRequiresFullAccess
          : session?.executionMode === "full-access"
      ) {
        backendRegistryLog.info("auto-approving ACP permission request", {
          backend,
          executionMode: session?.executionMode ?? "default",
          requestId: request.params.requestId,
          runtimeControlsExecutionMode,
          runtimeRequiresFullAccess,
          threadId: request.params.threadId,
          turnId: request.params.turnId,
        });
        return { decision: "approve" };
      }
    }

    const hostToolCall = readAgentDynamicToolCall({
      method: request.method,
      params: request.params,
    });
    if (hostToolCall && this.subAgentMonitorService.isTaskMonitorThread({ backend, threadId: hostToolCall.threadId })) {
      const allowedTools = hostToolCall.namespace === PWRAGENT_TOOL_NAMESPACE
        ? ["inject_progress", "complete_monitoring", "search_mcp_tools", "call_mcp_tool", "read_tool_guide",
            ...this.forgeToolBridge.buildTaskMonitorForgeToolDefinitions().map((tool) => tool.name)]
        : hostToolCall.namespace === TASK_MONITOR_TOOL_NAMESPACE
          ? ["inject_progress", "complete_monitoring"]
          : [];
      if (!allowedTools.includes(hostToolCall.tool)) {
        return toDynamicToolResponse({ ok: false, code: "forbidden", message: "Job Monitors may use only their lifecycle, read-only forge and MCP gateway tools." });
      }
    }
    // Keep dispatch available after disabling the experiment: older runtimes
    // can retain the previously advertised schema until a new thread starts.
    const toolSearchRouter = new AgentToolRouter([buildPwrAgentToolSearchDefinition([])]);
    if (hostToolCall && toolSearchRouter.acceptsDynamicToolCall(hostToolCall)) {
      if (backend !== "codex" || !this.isLiveDynamicToolCall(backend, hostToolCall)) {
        return toDynamicToolResponse({
          ok: false,
          code: "forbidden",
          message: "Tool search must originate from an active Codex turn on the owning thread.",
        });
      }
      const tokenMiserEnabled = await this.isTokenMiserDynamicToolCallEnabled(backend, hostToolCall);
      const router = new AgentToolRouter([buildPwrAgentToolSearchDefinition(
        await this.buildCodexParentDynamicTools(tokenMiserEnabled, false, undefined, { backend, threadId: hostToolCall.threadId, turnId: hostToolCall.turnId }),
        tokenMiserEnabled ? this.tokenMiserStore : undefined,
      )]);
      return await router.handleDynamicToolCall({ backend, call: hostToolCall });
    }
    const gatewayRouter = new AgentToolRouter(buildMcpGatewayToolDefinitions(this.mcpGatewayTools));
    if (hostToolCall && gatewayRouter.acceptsDynamicToolCall(hostToolCall)) {
      if (backend !== "codex" || !this.isLiveDynamicToolCall(backend, hostToolCall)) {
        return toDynamicToolResponse({ ok: false, code: "forbidden", message: "MCP gateway tools require an active turn on the owning thread." });
      }
      const enabled = await this.isTokenMiserDynamicToolCallEnabled(backend, hostToolCall);
      return await new AgentToolRouter(buildMcpGatewayToolDefinitions(this.mcpGatewayTools, enabled ? this.tokenMiserStore : undefined))
        .handleDynamicToolCall({ backend, call: hostToolCall });
    }
    const tokenMiserRouter = new AgentToolRouter(
      buildTokenMiserToolDefinitions(this.tokenMiserStore, this.tokenMiserService?.focused),
    );
    if (
      hostToolCall
      && tokenMiserRouter.acceptsDynamicToolCall(hostToolCall)
    ) {
      if (!(await this.isTokenMiserDynamicToolCallEnabled(
        backend,
        hostToolCall,
      ))) {
        return toDynamicToolResponse({
          ok: false,
          code: "forbidden",
          message: "Token Miser retrieval is disabled for this thread.",
        });
      }
      if (!this.isLiveDynamicToolCall(backend, hostToolCall)) {
        return toDynamicToolResponse({
          ok: false,
          code: "forbidden",
          message:
            "Token Miser retrieval must originate from an active turn on the owning thread.",
        });
      }
      return await tokenMiserRouter.handleDynamicToolCall({
        backend,
        call: hostToolCall,
      });
    }

    if (hostToolCall) {
      // Use the same definitions as advertisement, including compatibility
      // facades with advertise:false. Resolve all monitor roles for progress
      // and completion calls from monitor threads.
      const catalogs = resolveAgentToolCatalogs({
        appManagementHandler: this.appManagementHandler,
        currentTurnInputSource: this.currentTurnInputSource,
        automationInspectionHandler: this.automationInspectionHandler,
        federationHandler: this.federationHandler,
        mcpGatewayTools: this.mcpGatewayTools,
        mcpConnectionHandler: async (connectionRequest) =>
          await this.threadMcpConnections.handleAgentMcpConnectionRequest(connectionRequest),
        messagingHandler: this.messagingHandler,
        messagingWorkingUpdatesHandler: this.messagingWorkingUpdatesHandler,
        taskMonitorHandler: async (monitorRequest) =>
          await this.subAgentMonitorService.handleAgentTaskMonitorRequest(monitorRequest),
        threadInspectionHandler: this.threadInspectionHandler,
        forgeReadHandler: this.forgeToolBridge.gatedForgeReadHandler,
        forgePrToolHandler: this.forgeToolBridge.gatedForgePrToolHandler,
        // Deliberately omit forgeToolPolicy: stale definitions must reach
        // the per-call policy gate even after a tool is hidden in Settings.
        threadOrchestrationHandler: this.threadOrchestrationHandler,
        tokenMiserStore: this.tokenMiserStore,
        tokenMiserFocused: this.tokenMiserService?.focused,
        starMapHandler: this.starMapHandler,
        threadTodoHandler: this.threadTodoHandler,
        openAIDecisionsHandler: this.openAIDecisionsHandler,
        researchHandler: this.advertisedResearchHandler,
        checkoutHandler: this.checkoutHandler,
      }, { taskMonitorRole: "all" });
      const catalog = catalogs.find(({ router }) => router.acceptsDynamicToolCall(hostToolCall));
      // These adapters retain the historical namespace normalization and
      // unsupported-operation responses for persisted legacy definitions.
      const legacyRoutes = hostToolCall.namespace !== PWRAGENT_TOOL_NAMESPACE ? [
        {
          id: "automation_inspection" as const,
          accepts: isAutomationInspectionDynamicToolCall,
          dispatch: async () => await handleAutomationInspectionDynamicToolCall({
            backend, call: hostToolCall, handler: this.automationInspectionHandler,
          }),
        },
        {
          id: "thread_inspection" as const,
          accepts: isPwrAgentThreadDynamicToolCall,
          dispatch: async () => await handlePwrAgentThreadDynamicToolCall({
            backend, call: hostToolCall, handler: this.threadInspectionHandler,
          }),
        },
        {
          id: "app_management" as const,
          accepts: isPwrAgentAppDynamicToolCall,
          dispatch: async () => await handlePwrAgentAppDynamicToolCall({
            backend, call: hostToolCall, handler: this.appManagementHandler, responseFlushed: request.responseFlushed,
          }),
        },
        {
          id: "messaging_context" as const,
          accepts: isPwrAgentMessagingDynamicToolCall,
          dispatch: async () => await handlePwrAgentMessagingDynamicToolCall({
            backend, call: hostToolCall, handler: this.messagingHandler,
          }),
        },
      ] : [];
      const route = catalog ? {
        id: catalog.id,
        dispatch: async () => await catalog.router.handleDynamicToolCall({ backend, call: hostToolCall, signal, responseFlushed: request.responseFlushed }),
      } : legacyRoutes.find(({ accepts }) => accepts(hostToolCall));
      if (route) {
        const isTurnInputSourceTool = hostToolCall.namespace === PWRAGENT_TOOL_NAMESPACE
          && hostToolCall.tool === GET_CURRENT_TURN_INPUT_SOURCE;
        // The provider can ask while its turn/started notification is still
        // going through owner observers. Its exact in-flight ID is available at ingress.
        const pendingTurnStart = isTurnInputSourceTool && backend === "codex" && hostToolCall.turnId
          && this.context.turnState.pendingStartedTurnId(hostToolCall.threadId) === hostToolCall.turnId;
        if (!pendingTurnStart && !this.isLiveDynamicToolCall(backend, hostToolCall)) {
          const messages: Partial<Record<AgentToolCatalogId, string>> = {
            automation_inspection: "Automation inspection tool calls must originate from an active turn on the same thread.",
            thread_inspection: "Thread inspection tool calls must originate from an active turn on the same thread.",
            app_management: "App management tool calls must originate from an active turn on the same thread.",
            thread_orchestration: "Thread handoff tool calls must originate from an active turn on the same thread.",
            messaging_context: "Messaging context tool calls must originate from an active turn on the same thread.",
            forge: "Forge tool calls must originate from an active turn on the same thread.",
            federation: "Federation tool calls must originate from an active turn on the same thread.",
            star_map: "Star map tool calls must originate from an active turn on the same thread.",
          };
          return toDynamicToolResponse({
            ok: false,
            code: "forbidden",
            message: messages[route.id] ?? "PwrAgent tool calls must originate from an active turn on the owning thread.",
          });
        }
        const isHostContextTool = isTurnInputSourceTool || (hostToolCall.namespace === PWRAGENT_TOOL_NAMESPACE
          && hostToolCall.tool === "read_tool_guide");
        const category = isHostContextTool ? undefined : messagingDynamicToolCategoryForCatalog(route.id);
        const denied = category && await this.dynamicToolPermissionDenied(backend, category, hostToolCall);
        if (denied) {
          return toDynamicToolResponse({
            ok: false,
            code: "forbidden",
            message: agentToolPermissionDeniedMessage(hostToolCall.tool, denied),
          });
        }
        backendRegistryLog.info("handling catalog dynamic tool call", {
          backend,
          catalogId: route.id,
          callId: hostToolCall.callId,
          namespace: hostToolCall.namespace,
          threadId: hostToolCall.threadId,
          tool: hostToolCall.tool,
          turnId: hostToolCall.turnId,
        });
        return await route.dispatch();
      }
    }

    const taskMonitorToolCall = readTaskMonitorDynamicToolCall({
      method: request.method,
      params: request.params,
    });
    if (taskMonitorToolCall && isTaskMonitorDynamicToolCall(taskMonitorToolCall)) {
      backendRegistryLog.debug("handling task monitor dynamic tool call", {
        backend,
        callId: taskMonitorToolCall.callId,
        namespace: taskMonitorToolCall.namespace,
        threadId: taskMonitorToolCall.threadId,
        tool: taskMonitorToolCall.tool,
        turnId: taskMonitorToolCall.turnId,
      });
      return await handleTaskMonitorDynamicToolCall({
        backend,
        call: taskMonitorToolCall,
        handler: async (monitorRequest) =>
          await this.subAgentMonitorService.handleAgentTaskMonitorRequest(monitorRequest),
      });
    }

    // Host tools have no user response to wait for. A missing dispatch route
    // must fail here rather than leave an unresolvable interactive request.
    if (request.method === "item/tool/call") {
      return toDynamicToolResponse({
        ok: false,
        code: "unsupported_operation",
        message: "No PwrAgent handler is registered for this dynamic tool call.",
      });
    }

    const headlessAutomation = this.headlessAutomation.findHeadlessAutomationTurnForRequest(
      backend,
      request,
    );
    if (backend === "codex" && headlessAutomation && isMcpToolApproval(request)) {
      const serverName = String(request.params.serverName ?? "");
      const aliases = Object.values(headlessAutomation.mcpServerAliases ?? {})
        .filter((names) => names.includes(serverName)).flat();
      const selected = await this.threadMcpConnections.readThreadMcpConnections({
        backend, threadId: headlessAutomation.agentThreadId,
      });
      const connectionIds = Object.entries(headlessAutomation.mcpServerAliases ?? {})
        .filter(([, names]) => names.includes(serverName)).map(([id]) => id);
      const stillSelected = connectionIds.length > 0
        ? connectionIds.some((id) => headlessAutomation.mcpConnectionIds?.includes(id)
          && (selected.connectionIds.includes(id) || headlessAutomation.mcpGrantedConnectionIds?.includes(id)))
        : selected.providerServersEnabled;
      const consent = headlessAutomation.mcpAllowedServerNames?.includes(serverName)
        && stillSelected
        && this.headlessAutomation.findHeadlessAutomationTurnForRequest(backend, request)?.automationRunId === headlessAutomation.automationRunId
        ? buildAutomationMcpConsent({ request, serverNames: [serverName, ...aliases], toolAllowlist: headlessAutomation.toolAllowlist })
        : undefined;
      return consent ?? { action: "cancel", content: null, _meta: null };
    }
    if (headlessAutomation) {
      backendRegistryLog.warn("auto-cancelling headless automation server request", {
        agentThreadId: headlessAutomation.agentThreadId,
        automationName: headlessAutomation.automationName,
        automationRunId: headlessAutomation.automationRunId,
        backend,
        executionMode: headlessAutomation.executionMode,
        method: request.method,
        queueEntryId: headlessAutomation.queueEntryId,
        requestId: request.params.requestId,
        threadId: request.params.threadId,
        turnId: request.params.turnId,
      });
      return buildHeadlessAutomationRequestCancelResponse(request);
    }

    // Only main offers a project grant. A copy on the way in is not ours.
    if (request.method === "mcpServer/elicitation/request") {
      request = withoutMcpProjectToolApprovalOffer(request);
    }
    let projectOffer: McpProjectToolApprovalCardOffer | undefined;
    if (backend === "codex" && isMcpToolApproval(request)) {
      const decision = await this.threadMcpConnections.selectedConnectionMcpConsent(request, signal);
      if (decision?.consent) return decision.consent;
      projectOffer = decision?.projectOffer;
      if (projectOffer) {
        request = {
          ...request,
          params: {
            ...request.params,
            _meta: { ...readRecord(request.params._meta), [MCP_PROJECT_TOOL_APPROVAL_OFFER_META_KEY]: projectOffer.offer },
          },
        } as AppServerPendingRequestNotification;
      }
    }

    const managedReview = this.managedReviewService.findManagedReviewForChildRequest({
      backend,
      reviewThreadId: request.params.threadId,
      turnId: request.params.turnId ?? undefined,
    });
    const routedRequest = managedReview
      ? {
          ...request,
          params: {
            ...request.params,
            threadId: managedReview.parentThreadId,
            turnId: managedReview.turnId,
          },
        } as AppServerPendingRequestNotification
      : request;
    const routedBackend = managedReview?.parentBackend ?? backend;
    if (managedReview) {
      backendRegistryLog.info("managed review request routed to parent", {
        method: request.method,
        parentBackend: managedReview.parentBackend,
        parentThreadId: managedReview.parentThreadId,
        requestId: request.params.requestId,
        reviewBackend: managedReview.backend,
        reviewThreadId: managedReview.reviewThreadId,
        turnId: managedReview.turnId,
      });
    }

    const key = buildPendingRequestKey({
      backend: routedBackend,
      threadId: routedRequest.params.threadId,
      requestId: routedRequest.params.requestId,
    });

    if (signal?.aborted) return { decision: "cancel" };
    const response = await new Promise<SubmitServerRequestRequest["response"]>((resolve, reject) => {
      this.pendingServerRequests.set(key, {
        backend: routedBackend,
        notification: routedRequest,
        resolve,
        reject,
      });

      void this.emit({
        backend: routedBackend,
        notification: routedRequest as AppServerNotification,
      }).catch((error) => {
        backendRegistryLog.error(
          "failed to publish pending server request; keeping request pending",
          {
            backend: routedBackend,
            error: error instanceof Error ? error.message : String(error),
            requestId: routedRequest.params.requestId,
            threadId: routedRequest.params.threadId,
            turnId: routedRequest.params.turnId,
          },
        );
      });
    });
    if (request.method !== "mcpServer/elicitation/request") return response;
    return await this.threadMcpConnections.settleMcpProjectToolApprovalChoice(response, projectOffer);
  }

  /**
   * The open Claude process's mode wins, because a permission change during
   * the turn and a plan turn reach it before the saved thread. A thread with
   * no open process and no readable record asks.
   */
  private async resolveClaudeToolCallExecutionMode(
    threadId: string,
    automationMode?: ThreadExecutionMode,
  ): Promise<ThreadExecutionMode | undefined> {
    const liveMode = this.claudeBackend.liveExecutionMode(threadId);
    if (liveMode) return liveMode;
    if (automationMode) return automationMode;
    try {
      return await this.claudeBackend.executionMode(threadId);
    } catch {
      return undefined;
    }
  }

  private async resolveCodexToolCallExecutionMode(
    context: AgentToolCallContext,
    automationMode?: ThreadExecutionMode,
  ): Promise<ThreadExecutionMode | undefined> {
    const activeMode = context.turnId
      ? this.context.turnState.executionMode({ threadId: context.threadId, turnId: context.turnId })
      : undefined;
    return activeMode ?? automationMode
      ?? await this.resolveCodexThreadExecutionModeForActiveTurn(context.threadId);
  }

  private async isTokenMiserDynamicToolCallEnabled(
    backend: AppServerBackendKind,
    call: NonNullable<ReturnType<typeof readAgentDynamicToolCall>>,
  ): Promise<boolean> {
    if (backend !== "codex") {
      return false;
    }
    if (!this.resolveTokenMiserEnabledFn()) {
      return false;
    }
    const threadOverride = await this.resolveTokenMiserThreadOverride(
      backend,
      call.threadId,
    );
    return threadOverride ?? this.resolveTokenMiserDefaultEnabledFn();
  }

  private async resolveTokenMiserThreadOverride(
    backend: AppServerBackendKind,
    threadId: string,
  ): Promise<boolean | undefined> {
    const directOverlay = await this.overlayStore.getThreadOverlayState({
      backend,
      threadId,
    });
    if (directOverlay?.tokenMiserEnabled !== undefined) {
      return directOverlay.tokenMiserEnabled;
    }
    const managedReviewParent = this.managedReviewService.findManagedReviewParentForChild({
      backend,
      reviewThreadId: threadId,
    });
    if (managedReviewParent?.parentBackend !== "codex") {
      return undefined;
    }
    const parentOverlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: managedReviewParent.parentThreadId,
    });
    return parentOverlay?.tokenMiserEnabled;
  }

  private resolveTokenMiserEnabledForOverride(
    threadOverride: boolean | undefined,
  ): boolean {
    return (
      this.resolveTokenMiserEnabledFn()
      && (threadOverride ?? this.resolveTokenMiserDefaultEnabledFn())
    );
  }

  private isLiveDynamicToolCall(
    backend: AppServerBackendKind,
    call: { threadId: string; turnId?: string },
  ): boolean {
    const turnId = call.turnId?.trim();
    if (!turnId) return false;
    return this.context.turnState.hasRegisteredTurn({ backend: backend, threadId: call.threadId, turnId: turnId });
  }

  private clearAcceptedToolCallsForEndedTurn(
    backend: AppServerBackendKind,
    threadId: string,
    turnId: string,
  ): void {
    // Removing replay results while the turn is live would admit the same
    // call again. Both turn-ending paths remove that marker before eviction.
    if (this.isLiveDynamicToolCall(backend, { threadId, turnId })) return;

    const dynamicCallPrefix = [backend, threadId, turnId, ""].join("\u0000");
    for (const key of this.acceptedDynamicToolCalls.keys()) {
      if (key.startsWith(dynamicCallPrefix)) {
        this.acceptedDynamicToolCalls.delete(key);
      }
    }
    const handoffPrefix = ["handoff", backend, threadId, turnId, ""].join(":");
    for (const key of this.acceptedHandoffTaskRequests.keys()) {
      if (key.startsWith(handoffPrefix)) {
        this.acceptedHandoffTaskRequests.delete(key);
      }
    }
  }

  private resolveAgentToolMcpCallContext(
    context: AgentToolMcpClientContext,
  ): ResolvedAgentToolMcpCallContext | undefined {
    if (!context.threadId) {
      return undefined;
    }
    const matchingTurns = [...this.context.turnState.registeredTurnKeys()]
      .map(parseActiveTurnKey)
      .filter(
        (
          candidate,
        ): candidate is ResolvedAgentToolMcpCallContext =>
          Boolean(
            candidate
            && candidate.backend === context.backend
            && candidate.threadId === context.threadId,
          ),
      );
    if (matchingTurns.length !== 1) {
      backendRegistryLog.warn("MCP active turn resolution failed", {
        backend: context.backend,
        threadId: context.threadId,
        matchingTurnCount: matchingTurns.length,
        matchingTurnIds: matchingTurns.slice(0, 8).map((turn) => turn.turnId),
        activeTurnCount: this.context.turnState.registeredTurnCount,
        relatedActiveTurns: [...this.context.turnState.registeredTurnKeys()]
          .map(parseActiveTurnKey)
          .filter((turn) => turn
            && (turn.backend === context.backend || turn.threadId === context.threadId))
          .slice(0, 8),
        startReserved: this.reservedAcpStartThreadKeys.has(
          buildTurnStartReservationKey(context.backend, context.threadId),
        ),
      });
      return undefined;
    }
    return matchingTurns[0];
  }

  /**
   * RBAC gate for agent dynamic tools. When a turn was started by a messaging
   * user, the agent acting for them may only invoke tools their role permits.
   * Returns a required permission or a lifecycle denial when the call is
   * refused, or `null` to allow. Missing grants are audited by messaging.
   */
  private async dynamicToolPermissionDenied(
    backend: AppServerBackendKind,
    category: MessagingDynamicToolCategory,
    call: { threadId: string; turnId?: string; tool: string; arguments?: unknown },
  ): Promise<string | null> {
    // Profile settings enforce a stricter retained-actor gate inside their
    // handler, including when there is no controller or no attributed turn.
    if (permissionForDynamicTool(category, call.tool) === "tools.messaging_profile_settings") return null;
    if (call.tool === "manage_pwragent") {
      const denial = await this.appManagementPermissionDenied({ backend, threadId: call.threadId, turnId: call.turnId });
      if (denial) return denial;
    }
    const service = this.messagingAgentToolService;
    const causalContext = await this.readCausalMessagingContext({ backend, ...call });
    if (!service) return isCausalMessagingContext(causalContext) ? "message.reply" : null;
    const args =
      call.arguments && typeof call.arguments === "object"
        ? (call.arguments as Record<string, unknown>)
        : null;
    const permissionCheck = {
      backend,
      threadId: call.threadId,
      turnId: call.turnId,
      category,
      tool: call.tool,
      arguments: args,
    };
    const result = isCausalMessagingContext(causalContext)
      ? await service.authorizeRetainedTool?.({ backend, ...call, ...causalContext }, permissionCheck)
        ?? { allowed: false, permission: "message.reply" }
      : service.checkDynamicToolPermission(permissionCheck);
    if (result.allowed) return null;
    backendRegistryLog.warn("denying dynamic tool call: messaging RBAC", {
      backend,
      category,
      permission: result.permission,
      threadId: call.threadId,
      tool: call.tool,
      turnId: call.turnId,
    });
    return call.tool === "manage_pwragent" ? appManagementActorDenial(result) : result.permission ?? "required capability";
  }

  private async authorizeAgentToolMcpCall(params: {
    backend: AppServerBackendKind;
    catalogId?: AgentToolCatalogId;
    threadId: string;
    tool: string;
    turnId: string;
    arguments?: unknown;
  }): Promise<string | null> {
    const refusal = localAgentToolRefusal(params.tool);
    if (refusal) return refusal;
    if (params.tool === GET_CURRENT_TURN_INPUT_SOURCE) return null;
    const category = messagingDynamicToolCategoryForCatalog(params.catalogId);
    if (!category) {
      return null;
    }
    return this.dynamicToolPermissionDenied(params.backend, category, {
      threadId: params.threadId,
      turnId: params.turnId,
      tool: params.tool,
      arguments: params.arguments,
    });
  }

  /**
   * Storage roots that no local-file read may reach. Messaging shares these so
   * its outbound file tool refuses the same Codex-owned paths the turn-input
   * enrichment path already refuses.
   */
  getLocalFilePrivateStorageRoots(): readonly string[] {
    return this.localFilePrivateStorageRoots;
  }

  getTurnInputAttachments(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): AppServerTurnInputItem[] {
    return (
      this.turnInputAttachments.get(
        buildActiveTurnKey(params.backend, params.threadId, params.turnId),
      )?.input ?? []
    ).map((item) => ({ ...item }));
  }

  private async rememberTurnInputAttachments(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
    input: readonly AppServerTurnInputItem[];
  }): Promise<void> {
    const attachments = await stageTurnInputAttachmentsForRetention(
      params.input,
      { privateStorageRoots: this.localFilePrivateStorageRoots, owner: params },
    );
    if (attachments.length === 0) {
      return;
    }
    this.mergeTurnInputAttachments({
      ...params,
      input: attachments,
    });
  }

  private mergeTurnInputAttachments(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
    input: readonly AppServerTurnInputItem[];
  }): void {
    if (params.input.length === 0) {
      return;
    }
    const key = buildActiveTurnKey(
      params.backend,
      params.threadId,
      params.turnId,
    );
    const existing = this.turnInputAttachments.get(key)?.input ?? [];
    const attachmentKeys = new Set(existing.map(turnInputAttachmentCacheKey));
    const merged = [...existing];
    for (const item of params.input) {
      const attachmentKey = turnInputAttachmentCacheKey(item);
      if (attachmentKeys.has(attachmentKey)) {
        continue;
      }
      attachmentKeys.add(attachmentKey);
      merged.push(item);
    }
    this.turnInputAttachments.delete(key);
    this.turnInputAttachments.set(key, {
      input: merged,
    });
    while (this.turnInputAttachments.size > 256) {
      const oldestKey = this.turnInputAttachments.keys().next().value;
      if (!oldestKey) break;
      this.turnInputAttachments.delete(oldestKey);
    }
  }

  private async handleThreadOrchestrationRequest(
    request: PwrAgentThreadOrchestrationRequest,
    onCreated?: (worker: { backend: AppServerBackendKind; threadId: string }) => void,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    if (request.operation === "attach_thread_directory") {
      return await this.threadDirectoryService.attachThreadDirectory(request);
    }
    if (request.operation === "detach_thread_directory") {
      return await this.threadDirectoryService.detachThreadDirectory(request);
    }
    if (request.operation === "handoff_task") {
      if (this.researchWorkerCheck?.(request.context)) return threadOrchestrationFailure("forbidden", "Research workers must ask their coordinator for another assignment; they cannot delegate additional managed workers.");
      const response = await this.threadWorkspaceService.handoffTaskToThread(request, onCreated);
      if (response.ok && this.agentCreatedThreadObserver) {
        const created = response.data as HandoffTaskResult;
        try {
          this.agentCreatedThreadObserver(request.context, {
            backend: created.backend,
            threadId: created.threadId,
            ...(created.title ? { title: created.title } : {}),
            ...(created.groupedUnderThreadId
              ? { parent: { backend: request.context.backend, threadId: created.groupedUnderThreadId } }
              : {}),
          });
        } catch (error) {
          backendRegistryLog.warn("Could not report a handed-off thread to its viewers", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return response;
    }
    if (request.operation === "move_thread_workspace") {
      return await this.threadWorkspaceService.moveThreadWorkspace(request);
    }
    if (request.operation === "register_thread_worktree") {
      return await this.threadDirectoryService.registerThreadWorktree(request);
    }
    if (request.operation === "send_message_to_thread") {
      return await this.sendMessageToThread(request);
    }
    if (
      request.operation === "steer_thread"
      || request.operation === "stop_thread"
    ) {
      return await this.controlThreadTurn(request);
    }
    if (request.operation === "start_review") {
      return await this.managedReviewService.startReviewFromAgentTool(request);
    }
    return threadOrchestrationFailure(
      "unsupported_operation",
      "Unsupported PwrAgent thread orchestration operation.",
    );
  }

  /** Exact provenance only. Failure to learn a root leaves it unknown. */
  private async readDelegatedTurnAncestry(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
  }): Promise<{ parentTurnId?: string; rootTurnId?: string }> {
    if (params.backend !== "codex" || !params.turnId) return {};
    const turnId = params.turnId;
    const rootTurnId = await this.withCodexThreadClient(params.threadId,
      async (client) => await client.readTurnRoot?.({ threadId: params.threadId, turnId }),
      undefined, false).catch(() => undefined);
    return { parentTurnId: turnId, ...(rootTurnId ? { rootTurnId } : {}) };
  }

  private async buildAgentMessageOrigin(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
  }): Promise<AppServerThreadMessageOrigin> {
    const causalContext = await this.readCausalMessagingContext(params);
    const sourceThread = await this.resolveThread(params).catch(() => undefined);
    const sourceTitle = sourceThread?.title.trim();
    const ancestry = await this.readDelegatedTurnAncestry(params);
    return {
      kind: "agent",
      ...causalContext,
      sourceThread: {
        backend: params.backend,
        threadId: params.threadId,
        ...(ancestry.parentTurnId ? { turnId: ancestry.parentTurnId } : {}),
        ...(ancestry.rootTurnId ? { rootTurnId: ancestry.rootTurnId } : {}),
        ...(sourceTitle && sourceThread?.titleSource !== "fallback"
          ? { title: sourceTitle }
          : {}),
      },
    };
  }

  /** Operator dispatch of a to-do card: the raising thread, never a delegated turn. */
  async buildThreadTodoMessageOrigin(params: {
    backend: AppServerBackendKind;
    threadId: string;
    todo: { id: string; title?: string };
  }): Promise<AppServerThreadMessageOrigin> {
    // No turnId on purpose: the operator clicked the card, so no agent turn
    // sent this and no causal messaging or delegated lineage applies.
    const messageOrigin = await this.buildAgentMessageOrigin({
      backend: params.backend,
      threadId: params.threadId,
    });
    const threadTodo = threadTodoMessageOriginFromUnknown(params.todo);
    // The operator clicked the card, so a paused project's refusal of
    // messages from other threads lets it through.
    return {
      ...messageOrigin,
      operatorApproved: true,
      ...(threadTodo ? { threadTodo } : {}),
    };
  }

  /** Operator-approved to-do dispatch uses the same routing, queue and receipts as agent messages. */
  async sendThreadTodoMessage(params: {
    sourceBackend: AppServerBackendKind;
    sourceThreadId: string;
    target: { backend: AppServerBackendKind; threadId: string; instanceId?: string };
    prompt: string;
    todo: { id: string; title?: string };
  }): Promise<void> {
    // A viewer, or the card itself, can name this owner's thread by this
    // owner's id; delivery treats that thread as local here. A card stored
    // that way can name its own raising thread, which the card's own guard
    // only recognizes without an instance.
    const local = this.ownerRelativeTarget(params.target);
    if (
      local !== params.target
      && local.backend === params.sourceBackend
      && local.threadId === params.sourceThreadId
    ) {
      throw new ThreadTodoError("invalid_arguments", "Use Do it here for this card's own thread.");
    }
    const response = await this.deliverMessageToThread({
      operation: "send_message_to_thread",
      context: { backend: params.sourceBackend, threadId: params.sourceThreadId },
      args: {
        ...params.target,
        // A card raised without its owner still names one thread: a thread
        // this instance does not own is looked for on connected peers.
        includeRemote: true,
        prompt: params.prompt,
      },
    }, { threadTodo: params.todo, operatorApproved: true });
    if (!response.ok) throw new Error(response.error.message);
  }

  /**
   * Names the instance that owns a to-do's destination thread. An agent can
   * name a peer's thread by id alone; without the owner the card reads as
   * this machine's thread. A thread this instance owns, or one no peer
   * reports, is returned as given.
   */
  async locateThreadTodoMessageTarget(
    source: { backend: AppServerBackendKind; threadId: string },
    named: ThreadTodoMessageTarget,
  ): Promise<ThreadTodoMessageTarget> {
    // A card names its owner's own threads without an instance.
    const target = this.ownerRelativeTarget(named);
    // Naming this instance means this instance only: no peer is searched.
    const namesThisInstance = target !== named;
    if (target.instanceId) {
      await this.validateRemoteMessageTarget(target);
      if (target.instanceLabel && target.title) return target;
    }
    if (!target.instanceId) {
      const local = await this.resolveThread({ backend: target.backend, threadId: target.threadId })
        .catch(() => undefined);
      if (local) return target.title ? target : { ...target, title: local.title };
      const archived = await this.readArchivedMessageTarget(target).catch(() => undefined);
      if (archived) throw new ThreadTodoError("invalid_arguments", archivedThreadMessageRefusal(archived));
    }
    if (namesThisInstance || !this.federationHandler) return target;
    const response = await Promise.resolve(this.federationHandler({
      operation: "search_federation_threads",
      context: source,
      args: {
        query: target.threadId,
        scope: "remote",
        backend: target.backend,
        ...(target.instanceId ? { instanceId: target.instanceId } : {}),
        limit: 5,
      },
    })).catch(() => undefined);
    if (!response?.ok || !("results" in response.data)) return target;
    const found = response.data.results.find((result) =>
      !result.isLocal && result.backend === target.backend && result.threadId === target.threadId);
    if (!found) return target;
    const resolved = {
      ...target,
      instanceId: found.instanceId,
      instanceLabel: found.instanceLabel,
      title: target.title ?? found.title,
    };
    return target.instanceId ? resolved : await this.validateRemoteMessageTarget(resolved);
  }

  private async validateRemoteMessageTarget(target: ThreadTodoMessageTarget): Promise<ThreadTodoMessageTarget> {
    if (!target.instanceId || !this.federatedThreadInspectionHandler) return target;
    const remote = await this.federatedThreadInspectionHandler({
      backend: target.backend, threadId: target.threadId, instanceId: target.instanceId, limit: 0, includeTurns: false,
    }).catch(() => undefined);
    if (remote?.archived === true || remote?.thread.archivedAt !== undefined) {
      throw new ThreadTodoError("invalid_arguments", archivedThreadMessageRefusal(remote.thread));
    }
    return target;
  }

  private async readArchivedMessageTarget(target: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined> {
    return (await this.listThreads({
      backend: target.backend, archived: true, enrichDirectories: false, forceRefresh: true,
      callerReason: "thread-id-lookup",
    })).find((thread) => thread.id === target.threadId);
  }

  async sendResourceCheckoutHandoff(
    context: AgentToolCallContext,
    target: { backend: AppServerBackendKind; threadId: string; instanceId?: string },
    prompt: string,
    bind: () => Promise<void>,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    return await this.sendMessageToThread({
      operation: "send_message_to_thread", context,
      args: { ...target, includeRemote: Boolean(target.instanceId), prompt, delivery: "new_turn" },
    }, async () => {
      if (!this.isLiveDynamicToolCall(context.backend, context)) throw new Error("Checkout handoff requires an active source turn.");
      await bind();
    });
  }

  private async sendMessageToThread(
    named: PwrAgentThreadOrchestrationRequest<"send_message_to_thread">,
    beforeDelivery?: () => Promise<void>,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    // Before the paused-project gate, which leaves a peer's thread to its peer.
    const request = this.ownerRelativeRequest(named);
    const sourceTurnId = request.context.turnId?.trim();
    if (
      !sourceTurnId ||
      !this.isLiveDynamicToolCall(request.context.backend, {
        threadId: request.context.threadId,
        turnId: sourceTurnId,
      })
    ) {
      return threadOrchestrationFailure(
        "forbidden",
        "Thread orchestration tools must be invoked from a live turn.",
      );
    }
    const refusal = this.agentMessageProjectRefusal(request.args);
    if (refusal) return threadOrchestrationFailure(PROJECT_PAUSED_ERROR_CODE, refusal);
    // An agent's send is checked here, on the caller's instance, before a
    // local or federated send: a peer only sees a mode, not that an agent
    // asked for it. The operator's to-do dispatch delivers without it.
    if (
      request.args.executionMode !== undefined
      || request.args.approvalPolicy !== undefined
      || request.args.sandbox !== undefined
    ) {
      const accessRefusal = checkAgentAccessRequest(
        await this.resolveAgentCallerExecutionMode({
          backend: request.context.backend,
          threadId: request.context.threadId,
          turnId: sourceTurnId,
        }),
        request.args,
      );
      if (accessRefusal) {
        return threadOrchestrationFailure(accessRefusal.code, accessRefusal.message);
      }
    }
    return await this.deliverMessageToThread(request, beforeDelivery ? { beforeDelivery } : undefined);
  }

  /**
   * A paused project's refusal of an agent message addressed to one of its
   * local threads. An explicit instanceId addresses a peer's thread, which
   * that peer gates.
   */
  private agentMessageProjectRefusal(args: {
    backend: string;
    threadId: string;
    instanceId?: string;
  }): string | undefined {
    if (this.ownerRelativeInstanceId(args.instanceId) || !isAppServerBackendKind(args.backend)) return undefined;
    const threadId = args.threadId.trim();
    return threadId
      ? this.projectPausedThreadMessageRefusal({ backend: args.backend, threadId })
      : undefined;
  }

  private async deliverMessageToThread(
    named: PwrAgentThreadOrchestrationRequest<"send_message_to_thread">,
    /** Set only by the operator's to-do dispatch, never from tool arguments. */
    options?: { threadTodo?: { id: string; title?: string }; operatorApproved?: boolean; beforeDelivery?: () => Promise<void> },
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    const request = this.ownerRelativeRequest(named);
    const backend = request.args.backend;
    if (!isAppServerBackendKind(backend)) {
      return threadOrchestrationFailure(
        "invalid_arguments",
        "backend must be a known PwrAgent backend.",
      );
    }
    const threadId = request.args.threadId.trim();
    const instanceId = request.args.instanceId?.trim();
    const includeRemote = request.args.includeRemote !== false;
    const prompt = request.args.prompt;
    if (!threadId || !prompt.trim()) {
      return threadOrchestrationFailure(
        "invalid_arguments",
        "send_message_to_thread requires non-empty threadId and prompt strings.",
      );
    }
    if (instanceId && !includeRemote) {
      return threadOrchestrationFailure(
        "invalid_arguments",
        "instanceId cannot be used when includeRemote is false.",
      );
    }
    if (
      backend === request.context.backend &&
      threadId === request.context.threadId &&
      !instanceId
    ) {
      return threadOrchestrationFailure(
        "forbidden",
        "send_message_to_thread targets another thread. Continue the current thread by replying normally.",
      );
    }

    const correspondenceId = `correspondence:${randomUUID()}`;
    const source: { backend: AppServerBackendKind; threadId: string; title?: string } = {
      backend: request.context.backend,
      threadId: request.context.threadId,
    };
    try {
      const settings = {
        ...(request.args.executionMode
          ? { executionMode: request.args.executionMode }
          : {}),
        ...(request.args.model ? { model: request.args.model } : {}),
        ...(request.args.reasoningEffort
          ? { reasoningEffort: request.args.reasoningEffort }
          : {}),
        ...(request.args.serviceTier
          ? { serviceTier: request.args.serviceTier }
          : {}),
        ...(Object.hasOwn(request.args, "fastMode")
          ? { fastMode: request.args.fastMode }
          : {}),
        ...(request.args.approvalPolicy
          ? { approvalPolicy: request.args.approvalPolicy }
          : {}),
        ...(request.args.sandbox ? { sandbox: request.args.sandbox } : {}),
      };
      // Follow-up messages carry only the requested prompt. Copying the source
      // turn's attachments here makes images bounce back with every reply.
      const input = [{ type: "text" as const, text: prompt }];
      const messageOrigin = await this.buildAgentMessageOrigin({
        backend: request.context.backend,
        threadId: request.context.threadId,
        turnId: request.context.turnId,
      });
      const threadTodo = threadTodoMessageOriginFromUnknown(options?.threadTodo);
      if (threadTodo) messageOrigin.threadTodo = threadTodo;
      source.title = messageOrigin.sourceThread?.title;
      if (messageOrigin.sourceThread) {
        messageOrigin.sourceThread = { ...messageOrigin.sourceThread, messageId: correspondenceId };
      }
      // A peer's paused project lets a to-do card's send through.
      if (options?.operatorApproved) messageOrigin.operatorApproved = true;
      this.correspondenceStore.record({
        id: correspondenceId,
        source,
        destination: { backend, threadId, ...(instanceId ? { instanceId } : {}) },
        input,
        createdAt: Date.now(),
        state: "sending",
        sourceTurnId: request.context.turnId ?? this.getActiveTurnForThread(source)?.turnId,
        sourceItemId: request.context.callId,
      });
      let targetTitle: string | undefined;
      let targetInstanceId: string | undefined;
      let turn: {
        backend: AppServerBackendKind;
        threadId: string;
        turnId: string;
        queueStatus?: "queued";
        queueEntryId?: string;
        position?: number;
      };
      let localResolutionError: unknown;
      let localThread: AppServerThreadSummary | undefined;
      const remoteRequest = {
        ...(request.args.delivery ? { delivery: request.args.delivery } : {}),
        replaceQueueEntryId: request.args.replaceQueueEntryId,
        backend,
        threadId,
        input,
        messageOrigin,
        executionMode: request.args.executionMode,
        model: request.args.model,
        reasoningEffort: request.args.reasoningEffort,
        serviceTier: request.args.serviceTier,
        fastMode: request.args.fastMode,
        approvalPolicy: request.args.approvalPolicy,
        sandbox: request.args.sandbox,
      };
      // The provider listing is the same local ownership evidence used by
      // navigation. A remembered peer is only a fallback: two PwrAgent
      // profiles can share one harness profile and see the same thread UUID.
      // An explicitly addressed instance still selects that remote target.
      if (!instanceId) {
        try {
          localThread = await this.resolveThread({ backend, threadId });
          if (!localThread) {
            // Archive membership belongs to the provider's listing, even when
            // its rows omit archivedAt. Never wake a reclaimed workspace merely
            // because a prior status/search read warmed the archived cache.
            const archivedThread = await this.readArchivedMessageTarget({ backend, threadId });
            if (archivedThread) {
              return threadOrchestrationFailure(
                "forbidden",
                archivedThreadMessageRefusal(archivedThread),
                { backend, threadId, archived: true },
              );
            }
          }
        } catch (error) {
          localResolutionError = error;
        }
      }
      if (options?.beforeDelivery && localThread) {
        await options.beforeDelivery();
      }
      const rememberedRemoteTurn =
        !localThread && includeRemote && this.federatedThreadMessageHandler
        ? await this.federatedThreadMessageHandler({
            ...remoteRequest,
            ...(options?.beforeDelivery ? { beforeDelivery: options.beforeDelivery } : {}),
            ...(instanceId
              ? { instanceId }
              : { resolutionMode: "remembered_only" as const }),
          })
        : undefined;
      if (rememberedRemoteTurn) {
        turn = rememberedRemoteTurn;
        targetTitle = rememberedRemoteTurn.title;
        targetInstanceId = rememberedRemoteTurn.instanceId;
      } else if (instanceId) {
        throw new Error(`Thread not found: ${threadId}`);
      } else {
        if (localThread) {
          // Publish lifecycle receipts with the resolved title from the outset.
          this.correspondenceStore.update(source, correspondenceId, {
            state: "sending", destination: { backend, threadId, title: localThread.title },
          });
          if (request.args.replaceQueueEntryId) {
            turn = await this.replaceQueuedAgentMessage({
              backend,
              threadId,
              queueEntryId: request.args.replaceQueueEntryId,
              input,
              messageOrigin,
            });
          } else {
            const submitted = await this.submitTurn({
              delivery: request.args.delivery,
              backend,
              threadId,
              input,
              origin: "manual",
              messageOrigin,
              executionMode: request.args.executionMode,
              model: request.args.model,
              reasoningEffort: request.args.reasoningEffort,
              serviceTier: request.args.serviceTier,
              fastMode: request.args.fastMode,
              approvalPolicy: request.args.approvalPolicy,
              sandbox: request.args.sandbox,
            });
            turn = submitted.status === "started"
              ? {
                  backend: submitted.entry.backend,
                  threadId: submitted.entry.threadId,
                  turnId: submitted.turnId,
                }
              : {
                  backend: submitted.entry.backend,
                  threadId: submitted.entry.threadId,
                  turnId: submitted.entry.id,
                  queueStatus: "queued",
                  queueEntryId: submitted.entry.id,
                  position: submitted.position,
                };
          }
          targetTitle = localThread.title;
        } else if (includeRemote && this.federatedThreadMessageHandler) {
          const discoveredRemoteTurn = await this.federatedThreadMessageHandler({
            ...remoteRequest,
            resolutionMode: "discover_only",
          });
          if (!discoveredRemoteTurn) {
            if (localResolutionError) {
              throw localResolutionError;
            }
            throw new Error(`Thread not found: ${threadId}`);
          }
          turn = discoveredRemoteTurn;
          targetTitle = discoveredRemoteTurn.title;
          targetInstanceId = discoveredRemoteTurn.instanceId;
        } else {
          if (localResolutionError) {
            throw localResolutionError;
          }
          throw new Error(`Thread not found: ${threadId}`);
        }
      }
      const threadLinkRef = {
        backend,
        ...(targetInstanceId ? { instanceId: targetInstanceId } : {}),
        threadId: turn.threadId,
      };
      if (request.args.replaceQueueEntryId) {
        try {
          const replaced = this.correspondenceStore.cancelQueuedInput(source, {
            backend, threadId, ...(targetInstanceId ? { instanceId: targetInstanceId } : {}),
          }, request.args.replaceQueueEntryId);
          for (const record of replaced) this.publishCorrespondenceMessage(source, record.id);
        } catch (error) {
          // The recipient already accepted the edit. A sender-side log failure
          // must not encourage another send of the same findings.
          backendRegistryLog.error("Could not persist replaced cross-thread message", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.updateCorrespondenceStatus(source, correspondenceId, {
        state: turn.queueStatus === "queued" ? "queued" : "started",
        destination: { ...threadLinkRef, title: targetTitle },
        queueEntryId: turn.queueEntryId,
        ...(turn.queueStatus === "queued" ? {} : { turnId: turn.turnId }),
      }, true);
      const messageId = turn.queueStatus === "queued"
        ? undefined
        : buildTurnUserMessageOriginId(turn.turnId);
      const messageLinkRef = messageId
        ? { ...threadLinkRef, messageId }
        : undefined;
      return {
        ok: true,
        data: {
          backend,
          threadId: turn.threadId,
          ...(targetInstanceId ? { instanceId: targetInstanceId } : {}),
          turnId: turn.turnId,
          ...(turn.queueStatus === "queued"
            ? {
                queueStatus: turn.queueStatus,
                queueEntryId: turn.queueEntryId,
                guidance: "Pending guidance is grouped across senders and prefers steering. Replace your own contribution with replaceQueueEntryId and your complete consolidated prompt; other senders' contributions are preserved.",
                ...(turn.position === undefined ? {} : { position: turn.position }),
              }
            : {}),
          promptPreview: truncateThreadInspectionText(prompt, 240),
          threadUrl: buildThreadUrl(threadLinkRef),
          threadLink: buildThreadMarkdownLink({
            ...threadLinkRef,
            title: targetTitle,
          }),
          ...(messageLinkRef
            ? {
                messageId,
                messageUrl: buildThreadUrl(messageLinkRef),
                messageLink: buildThreadMarkdownLink({
                  ...messageLinkRef,
                  title: targetTitle,
                }),
              }
            : {}),
          settings,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return threadOrchestrationFailure(
        // A peer's paused project refuses through its startTurn error text.
        isProjectPausedThreadMessageRefusal(message)
          ? PROJECT_PAUSED_ERROR_CODE
          // The target's own ceiling refuses on its owner, a peer included.
          : isAgentAccessRefusalMessage(message)
            ? "forbidden"
            : error instanceof PwrAgentFederatedThreadMessageError
              ? error.code
              : /not found/i.test(message)
                ? "not_found"
                : "turn_start_failed",
        message,
      );
    }
  }

  private async controlThreadTurn(
    request: PwrAgentThreadOrchestrationRequest<"steer_thread" | "stop_thread">,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    // Steering is a message; stopping starts nothing, so a pause allows it.
    const refusal = request.operation === "steer_thread"
      ? this.agentMessageProjectRefusal(request.args)
      : undefined;
    if (refusal) return threadOrchestrationFailure(PROJECT_PAUSED_ERROR_CODE, refusal);
    const requestKey = [
      request.operation,
      request.args.backend,
      request.args.threadId,
      request.args.instanceId ?? "local-or-discover",
      request.args.requestId,
    ].join("\u0000");
    const signature = createHash("sha256")
      .update(JSON.stringify({
        args: request.args,
        sourceBackend: request.context.backend,
        sourceThreadId: request.context.threadId,
      }))
      .digest("hex");
    const accepted = this.acceptedThreadControlRequests.get(requestKey);
    if (accepted) {
      if (accepted.signature !== signature) {
        return threadOrchestrationFailure(
          "invalid_arguments",
          `Thread control request id ${request.args.requestId} was reused with different arguments.`,
        );
      }
      const response = await accepted.promise;
      return response.ok
        ? {
            ok: true,
            data: {
              ...response.data,
              idempotentReplay: true,
            },
          }
        : response;
    }

    const promise = this.performThreadTurnControlWithFallback(request);
    if (
      this.acceptedThreadControlRequests.size
      >= MAX_ACCEPTED_THREAD_CONTROL_REQUESTS
    ) {
      const oldestKey = this.acceptedThreadControlRequests.keys().next().value;
      if (oldestKey) {
        this.acceptedThreadControlRequests.delete(oldestKey);
      }
    }
    this.acceptedThreadControlRequests.set(requestKey, { promise, signature });
    try {
      const response = await promise;
      if (
        !response.ok
        && this.acceptedThreadControlRequests.get(requestKey)?.promise === promise
      ) {
        this.acceptedThreadControlRequests.delete(requestKey);
      }
      return response;
    } catch (error) {
      if (this.acceptedThreadControlRequests.get(requestKey)?.promise === promise) {
        this.acceptedThreadControlRequests.delete(requestKey);
      }
      throw error;
    }
  }

  private async performThreadTurnControlWithFallback(
    named: PwrAgentThreadOrchestrationRequest<"steer_thread" | "stop_thread">,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    const request = this.ownerRelativeRequest(named);
    const controlled = await this.performThreadTurnControl(request);
    if (
      request.operation !== "steer_thread"
      || controlled.ok
      || (
        controlled.error.code !== "no_active_turn"
        && controlled.error.code !== "stale_target"
      )
    ) {
      return controlled;
    }

    const delivered = await this.sendMessageToThread({
      operation: "send_message_to_thread",
      context: request.context,
      args: {
        backend: request.args.backend,
        threadId: request.args.threadId,
        ...(request.args.instanceId
          ? { instanceId: request.args.instanceId }
          : {}),
        ...(typeof request.args.includeRemote === "boolean"
          ? { includeRemote: request.args.includeRemote }
          : {}),
        prompt: request.args.prompt,
      },
    });
    if (!delivered.ok) {
      return delivered;
    }
    if (!("threadUrl" in delivered.data) || !("settings" in delivered.data)) {
      return threadOrchestrationFailure(
        "internal_error",
        "Steer fallback returned an unexpected delivery result.",
      );
    }

    const fallback = delivered.data;
    return {
      ok: true,
      data: {
        backend: fallback.backend,
        threadId: fallback.threadId,
        ...(fallback.instanceId ? { instanceId: fallback.instanceId } : {}),
        requestId: request.args.requestId,
        turnId: fallback.turnId,
        disposition: fallback.queueStatus === "queued" ? "queued" : "started",
        fallbackReason: controlled.error.code,
        ...(fallback.queueEntryId
          ? { queueEntryId: fallback.queueEntryId }
          : {}),
        ...(fallback.position === undefined
          ? {}
          : { position: fallback.position }),
        promptPreview: fallback.promptPreview,
        threadUrl: fallback.threadUrl,
        threadLink: fallback.threadLink,
        ...(fallback.messageId ? { messageId: fallback.messageId } : {}),
        ...(fallback.messageUrl ? { messageUrl: fallback.messageUrl } : {}),
        ...(fallback.messageLink ? { messageLink: fallback.messageLink } : {}),
      },
    };
  }

  private async performThreadTurnControl(
    request: PwrAgentThreadOrchestrationRequest<"steer_thread" | "stop_thread">,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    const sourceTurnId = request.context.turnId?.trim();
    if (
      !sourceTurnId
      || !this.isLiveDynamicToolCall(request.context.backend, {
        threadId: request.context.threadId,
        turnId: sourceTurnId,
      })
    ) {
      return threadOrchestrationFailure(
        "forbidden",
        "Thread control tools must be invoked from a live turn.",
      );
    }
    const backend = request.args.backend;
    if (!isAppServerBackendKind(backend)) {
      return threadOrchestrationFailure(
        "unsupported_backend",
        "backend must be a known PwrAgent backend.",
      );
    }
    const threadId = request.args.threadId.trim();
    const instanceId = request.args.instanceId?.trim();
    const includeRemote = request.args.includeRemote !== false;
    if (
      backend === request.context.backend
      && threadId === request.context.threadId
      && !instanceId
    ) {
      return threadOrchestrationFailure(
        "forbidden",
        request.operation === "stop_thread"
          ? "stop_thread cannot interrupt its own current turn because the tool result could not be delivered safely."
          : "steer_thread cannot steer its own current turn; reply normally to add guidance.",
      );
    }

    const messageOrigin = await this.buildAgentMessageOrigin({
      backend: request.context.backend,
      threadId: request.context.threadId,
      turnId: request.context.turnId,
    });
    const remoteRequest = {
      operation: request.operation === "stop_thread" ? "stop" as const : "steer" as const,
      backend,
      threadId,
      requestId: request.args.requestId,
      ...(request.args.expectedTurnId
        ? { expectedTurnId: request.args.expectedTurnId }
        : {}),
      ...(request.operation === "steer_thread"
        ? {
            input: [
              { type: "text" as const, text: request.args.prompt },
            ],
          }
        : {}),
      messageOrigin,
    };

    try {
      let targetInstanceId: string | undefined;
      let result:
        | {
            backend: AppServerBackendKind;
            threadId: string;
            turnId: string;
            disposition: "interrupted" | "queued" | "steered";
            idempotentReplay?: boolean;
          }
        | undefined;
      // Match send and inspection routing: resolve through our provider
      // before consulting remembered federation ownership.
      const localThread = !instanceId
        ? await this.resolveThread({ backend, threadId }).catch(() => undefined)
        : undefined;
      if (!localThread && !instanceId && request.operation === "steer_thread") {
        const archived = await this.readArchivedMessageTarget({ backend, threadId }).catch(() => undefined);
        if (archived) {
          return threadOrchestrationFailure("forbidden", archivedThreadMessageRefusal(archived), { backend, threadId, archived: true });
        }
      }
      const rememberedRemote =
        !localThread && includeRemote && this.federatedThreadControlHandler
          ? await this.federatedThreadControlHandler({
              ...remoteRequest,
              ...(instanceId
                ? { instanceId }
                : { resolutionMode: "remembered_only" as const }),
            })
          : undefined;
      if (rememberedRemote) {
        result = rememberedRemote;
        targetInstanceId = rememberedRemote.instanceId;
      } else if (instanceId) {
        return threadOrchestrationFailure(
          this.federatedThreadControlHandler
            ? "stale_target"
            : "peer_unavailable",
          this.federatedThreadControlHandler
            ? `Thread ${threadId} was not found on federation instance ${instanceId}.`
            : `Federation routing is unavailable; instance ${instanceId} could not be reached.`,
          { backend, instanceId, threadId },
        );
      } else {
        if (localThread) {
          const backendSummary = (
            await this.listBackends({ includeUnavailable: true })
          ).backends.find((candidate) => candidate.kind === backend);
          if (!backendSummary?.available) {
            return threadOrchestrationFailure(
              "unsupported_backend",
              `Backend ${backend} is not available on this instance.`,
              { backend, threadId },
            );
          }
          const capability =
            request.operation === "stop_thread" ? "interruptTurn" : "steerTurn";
          if (!backendSummary.capabilities[capability]) {
            return threadOrchestrationFailure(
              "unsupported_capability",
              `Backend ${backend} does not support ${request.operation === "stop_thread" ? "turn interruption" : "turn steering"}.`,
              { backend, threadId },
            );
          }
          const controlled = await this.controlActiveTurn(remoteRequest);
          if (!controlled.ok) {
            return threadOrchestrationFailure(
              controlled.error.code,
              controlled.error.message,
              {
                ...(controlled.error.activeTurnId
                  ? { activeTurnId: controlled.error.activeTurnId }
                  : {}),
                backend,
                ...(controlled.error.expectedTurnId
                  ? { expectedTurnId: controlled.error.expectedTurnId }
                  : {}),
                threadId,
              },
            );
          }
          result = {
            backend: controlled.backend,
            threadId: controlled.threadId,
            turnId: controlled.turnId,
            disposition: controlled.disposition,
            ...(controlled.idempotentReplay
              ? { idempotentReplay: true }
              : {}),
          };
        } else if (includeRemote && this.federatedThreadControlHandler) {
          const discovered = await this.federatedThreadControlHandler({
            ...remoteRequest,
            resolutionMode: "discover_only",
          });
          if (discovered) {
            result = discovered;
            targetInstanceId = discovered.instanceId;
          }
        }
      }

      if (!result) {
        if (!includeRemote) {
          const localBackend = (
            await this.listBackends({ includeUnavailable: true })
          ).backends.find((candidate) => candidate.kind === backend);
          if (!localBackend?.available) {
            return threadOrchestrationFailure(
              "unsupported_backend",
              `Backend ${backend} is not available on this instance.`,
              { backend, threadId },
            );
          }
        }
        return threadOrchestrationFailure(
          "not_found",
          `Thread ${backend}:${threadId} was not found${includeRemote ? " locally or on a connected Federation peer" : " locally"}.`,
          { backend, threadId },
        );
      }
      const base = {
        backend: result.backend,
        threadId: result.threadId,
        ...(targetInstanceId ? { instanceId: targetInstanceId } : {}),
        requestId: request.args.requestId,
        turnId: result.turnId,
        ...(result.idempotentReplay ? { idempotentReplay: true } : {}),
      };
      return request.operation === "stop_thread"
        ? {
            ok: true,
            data: {
              ...base,
              disposition: "interrupted",
              interruptedAt: Date.now(),
            },
          }
        : {
            ok: true,
            data: {
              ...base,
              disposition:
                result.disposition === "queued" ? "queued" : "steered",
              promptPreview: truncateThreadInspectionText(request.args.prompt, 240),
            },
          };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return threadOrchestrationFailure(
        error instanceof PwrAgentFederatedThreadMessageError
          ? error.code
          : isThreadLockRefusal(message)
            ? "forbidden"
            : /unsupported|does not support/i.test(message)
              ? "unsupported_capability"
              : /active|expected turn|stale/i.test(message)
                ? "stale_target"
                : "internal_error",
        message,
        {
          backend,
          ...(instanceId ? { instanceId } : {}),
          threadId,
        },
      );
    }
  }

  readonly ownerContentSearch = new OwnerContentSearch(async (request, signal) => {
    if (!this.ownerThreadSearchService) {
      this.ownerThreadSearchService = new ThreadSearchService(
        createThreadSearchStorage(),
        async (params) => await this.listThreadSearchCandidates(params),
        new ProviderTranscriptThreadSearchAdapter(async (params) => await this.readThreadForContentSearch(params)),
      );
    }
    return await this.ownerThreadSearchService.search(request, signal);
  });

  /** Search needs provider text, not selection-time directory, review, or usage hydration. */
  private async readThreadForContentSearch(request: {
    backend: AppServerBackendKind;
    threadId: string;
    limit: number;
  }): Promise<AppServerReadThreadResponse> {
    this.assertNotBootstrap("readThreadForContentSearch");
    const { backend, threadId, limit } = request;
    const replay = backend === "claude"
      // The whole transcript is already in memory; search all of it.
      ? await this.claudeBackend.readThread(threadId)
      : isAcpBackendId(backend)
        ? pageNormalizedReplay(await this.acpBackend.readReplay(backend, threadId), request)
        : await this.withCodexThreadClient(threadId,
          async (client) => await client.readThread({ threadId, limit }), undefined, false);
    return { backend, threadId, fetchedAt: Date.now(), replay };
  }

  private notificationsEnabled(): boolean {
    try {
      return getDesktopSettingsService().resolveNotificationsEnabled();
    } catch (error) {
      if (!this.hasLoggedNotificationsEnabledError) {
        this.hasLoggedNotificationsEnabledError = true;
        backendRegistryLog.warn(
          "failed to read notificationsEnabled setting; suppressing notifications",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return false;
    }
  }

  /**
   * Teach the information store that a thread's archived state changed.
   *
   * Archival is a fact about the thread, so it is an observation like any
   * other, and it is deliberately separate from `invalidateThreadListCache`.
   * Invalidation says a query's result may have changed; it does not say a
   * thread was archived, and conflating the two is what made the list cache the
   * only record of archival — and therefore made forgetting it mandatory.
   */
  private recordThreadArchivalFromNotification(
    backend: AppServerBackendKind,
    notification: AgentEvent["notification"],
  ): void {
    const archived =
      notification.method === "thread/archived"
        ? true
        : notification.method === "thread/unarchived"
          ? false
          : undefined;
    if (archived === undefined) {
      return;
    }
    const threadId = (notification.params as { threadId?: unknown })?.threadId;
    if (typeof threadId !== "string") {
      return;
    }
    this.threadInfoStore.observe({
      archived,
      identity: { backend, threadId },
      observationSequence: this.reserveThreadInfoObservation(),
      source: "lifecycle-notification",
    });
  }

  /**
   * Take the sequence an observation will be recorded at. Asynchronous readers
   * MUST call this before they start: a listing that is overtaken by a rename
   * and then completes late carries the older sequence it reserved, so its
   * stale rows lose instead of silently reverting the rename.
   */
  private reserveThreadInfoObservation(): number {
    return this.threadInfoStore.reserveObservationSequence();
  }

  private rememberThreadTitleFromEvent(event: AgentEvent): void {
    const method = event.notification.method;
    this.recordThreadArchivalFromNotification(event.backend, event.notification);
    if (method === "thread/name/updated") {
      const params = event.notification.params as {
        threadId?: unknown;
        threadName?: unknown;
        titleSource?: unknown;
      };
      const threadId = params.threadId;
      const threadName = params.threadName;
      if (typeof threadId === "string" && typeof threadName === "string") {
        const trimmed = threadName.trim();
        if (trimmed) {
          const key = buildThreadIdentityKey(event.backend, threadId);
          const titleSource = normalizeRenamedTitleSource(params.titleSource);
          this.threadInfoStore.observe({
            identity: { backend: event.backend, threadId },
            observationSequence: this.reserveThreadInfoObservation(),
            source: "lifecycle-notification",
            title: trimmed,
            titleSource,
          });
          // Only where a provider can still contradict us. This map is the
          // "provider has not echoed our rename back yet" set, and every
          // reader of it is Codex-facing; the sole path that removes an entry
          // is the Codex listing. An ACP rename has no such window — it wrote
          // the session store on its way here, and that store is what ACP
          // listings read — so remembering one only leaks an entry that
          // nothing can ever retire.
          if (!isAcpBackendId(event.backend)) {
            this.observedThreadNames.set(key, { title: trimmed, titleSource });
          }
        }
      }
      return;
    }
    if (method === "thread/started") {
      const params = event.notification.params as {
        threadId?: unknown;
        thread?: Record<string, unknown>;
      };
      const threadId = params.threadId;
      if (typeof threadId !== "string") {
        return;
      }
      this.rememberThreadNotificationContext(
        event.backend,
        threadId,
        params.thread,
        this.reserveThreadInfoObservation(),
      );
    }
  }

  private withObservedThreadName(
    thread: AppServerThreadSummary,
  ): AppServerThreadSummary {
    const key = buildThreadIdentityKey(thread.source, thread.id);
    const observed = this.observedThreadNames.get(key);
    if (!observed) {
      return thread;
    }
    if (thread.titleSource === observed.titleSource) {
      // Matching provenance means the provider acknowledged our event. Text
      // that differs under the same source is durable provider truth from a
      // rename this process may not have observed (profiles can be shared by
      // processes). Comparing against the recorded source rather than a
      // hardcoded `explicit` is what lets a generated title retire: stamping
      // `explicit` here would also overwrite the `derived` the rename set,
      // leaving listThreads and getThreadInfo permanently disagreeing.
      this.observedThreadNames.delete(key);
      return thread;
    }
    return {
      ...thread,
      title: observed.title,
      titleSource: observed.titleSource,
    };
  }

  private observedCodexThreadIdsMatchingFilter(filter?: string): Set<string> {
    const normalizedFilter = filter?.trim().toLowerCase();
    const threadIds = new Set<string>();
    if (!normalizedFilter) {
      return threadIds;
    }
    const keyPrefix = buildThreadIdentityKey("codex", "");
    for (const [key, observed] of this.observedThreadNames) {
      if (
        key.startsWith(keyPrefix)
        && observed.title.toLowerCase().includes(normalizedFilter)
      ) {
        threadIds.add(key.slice(keyPrefix.length));
      }
    }
    return threadIds;
  }

  private rememberThreadNotificationContext(
    backend: AppServerBackendKind,
    threadId: string,
    thread: unknown,
    displayMetadataObservationSequence: number,
  ): void {
    if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
      return;
    }
    const record = thread as Record<string, unknown>;
    const candidate =
      (typeof record.title === "string" ? record.title : undefined) ??
      (typeof record.name === "string" ? record.name : undefined);
    const titleSource =
      record.titleSource === "explicit"
      || record.titleSource === "derived"
      || record.titleSource === "fallback"
        ? record.titleSource
        : undefined;
    const projectLabel = readNotificationProjectLabel(record);
    // A rename the provider has not acknowledged yet outranks the title in this
    // payload. `thread/started` replays the provider's own record, which on a
    // resume is the pre-rename one; without this the operator's rename loses on
    // sequence alone and the quit dialog reverts to the old name. The provider
    // acknowledging the rename clears the entry (see withObservedThreadName),
    // after which its titles are believed normally.
    const unacknowledgedRename = this.observedThreadNames.get(
      buildThreadIdentityKey(backend, threadId),
    );
    const title = unacknowledgedRename?.title ?? candidate;
    this.threadInfoStore.observe({
      identity: { backend, threadId },
      observationSequence: displayMetadataObservationSequence,
      source: "lifecycle-notification",
      ...(title !== undefined ? { title } : {}),
      // The rename's own provenance, not a fresh guess. This observation takes
      // a newer sequence than the rename did, so asserting `explicit` here
      // would silently revert a generated title on the next resume replay.
      ...(unacknowledgedRename !== undefined
        ? { titleSource: unacknowledgedRename.titleSource }
        : titleSource !== undefined
          ? { titleSource }
          : {}),
      ...(projectLabel !== undefined ? { projectLabel } : {}),
    });
  }

  /**
   * Fold a completed listing into the thread information store. Every row is
   * offered, including fallback-titled ones: the store decides what a fallback
   * means, so a provider that has lost its title index cannot push uuids over
   * names PwrAgent already knows.
   */
  private rememberThreadListContexts(
    threads: readonly AppServerThreadSummary[],
    displayMetadataObservationSequence: number,
    enriched: boolean,
    listedArchived: boolean | undefined,
  ): void {
    for (const thread of threads) {
      const identity = { backend: thread.source, threadId: thread.id };
      if (listedArchived !== true) {
        this.threadArchiveCoordinator.observeActiveThreadWorkspace(thread, enriched);
      }
      const projectLabel = readNotificationProjectLabel(
        thread as unknown as Record<string, unknown>,
      );
      this.threadInfoStore.observe({
        identity,
        observationSequence: displayMetadataObservationSequence,
        source: "provider-list",
        // Only a listing that actually filtered by archival proves anything
        // about it, and the row itself proves less than it looks like it does:
        // an active Codex listing merges cached archived metadata into its
        // rows, and `mergeThreadSummaries` returns the archived row wholesale
        // when its titleSource outranks the active one. That cache refreshes on
        // a 60s interval, so for up to a minute after an unarchive an *active*
        // listing can hand back a row still carrying `archivedAt` -- which
        // would overwrite the `thread/unarchived` notification at a newer
        // sequence and withhold a live thread. `archivedAt` is also a
        // normalized epoch that can legitimately be 0, so presence is not even
        // a safe test for it. Record the query's own filter or nothing.
        ...(listedArchived === undefined ? {} : { archived: listedArchived }),
        title: thread.title,
        ...(thread.titleSource ? { titleSource: thread.titleSource } : {}),
        ...(projectLabel ? { projectLabel } : {}),
        ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
      });
      this.threadInfoStore.observeSummary({
        enriched,
        identity,
        observationSequence: displayMetadataObservationSequence,
        summary: thread,
      });
    }
  }

  private notificationThreadContextLabel(
    backend: AppServerBackendKind,
    threadId: string,
  ): string | undefined {
    const info = this.threadInfoStore.get({ backend, threadId });
    const projectLabel = info?.projectLabel;
    const threadTitle = info?.title;
    if (projectLabel && threadTitle) {
      return `${projectLabel} > ${threadTitle}`;
    }
    return threadTitle ?? projectLabel;
  }

  /**
   * Label a terminal notification, reconciling once when nothing is known yet.
   *
   * The store answers for any thread this process has listed or seen start,
   * which is nearly all of them, and that read is free. The remaining case is a
   * turn completing on a thread this process never observed — an external
   * process sharing the profile — where a label still beats "A turn completed".
   *
   * The reconciliation is deduplicated per thread because turn completions
   * arrive in bursts across concurrent threads, and an unlabeled thread would
   * otherwise start a fresh whole-collection walk for each one. The walk seeds
   * the information store, so it happens at most once per thread per process
   * rather than once per notification.
   */
  private async notificationThreadContextLabelForTerminal(
    backend: AppServerBackendKind,
    threadId: string,
  ): Promise<string | undefined> {
    const cached = this.notificationThreadContextLabel(backend, threadId);
    if (cached) {
      return cached;
    }
    const key = buildThreadIdentityKey(backend, threadId);
    let reconciliation = this.notificationContextReconciliations.get(key);
    if (!reconciliation) {
      // Retried only when the walk produced no rows at all. "Learned no label"
      // is not a failure -- it is the answer for a thread this backend does not
      // list, which is precisely the case this dedup exists for, so keying the
      // retry on the label drops the entry every time and charges each of that
      // thread's later notifications another walk.
      //
      // Rejection is not the signal either: `listThreads` absorbs a provider
      // error and resolves, so the `catch` below never runs for the restart it
      // was written for. An empty result is the observable form of that
      // failure, and it is also indistinguishable from a genuinely empty
      // backend -- retrying both is right, because neither has an answer to
      // memoize.
      let walkListedRows = false;
      reconciliation = this.listThreads({
        backend,
        callerReason: "notification-context",
        enrichDirectories: false,
      })
        .then((rows) => {
          walkListedRows = rows.length > 0;
        })
        .catch((error: unknown) => {
          backendRegistryLog.debug("native terminal notification context lookup failed", {
            backend,
            error: error instanceof Error ? error.message : String(error),
            threadId,
          });
        })
        .finally(() => {
          // Only retract this walk's own entry. The cap below can evict a key
          // whose walk is still running, and a later notification then stores a
          // fresh promise under it -- deleting by key alone would throw that
          // one away when this older walk settled, and the next notification
          // would start a third. Same ownership check the thread-list cache
          // uses when its pending entry settles.
          if (
            !walkListedRows
            && this.notificationContextReconciliations.get(key) === reconciliation
          ) {
            this.notificationContextReconciliations.delete(key);
          }
        });
      // Settled entries are kept on purpose -- they are the memo -- so this is
      // bounded by count rather than by liveness.
      rememberBoundedMap(
        this.notificationContextReconciliations,
        key,
        reconciliation,
        NOTIFICATION_CONTEXT_RECONCILIATION_LIMIT,
      );
    }
    await reconciliation;
    return this.notificationThreadContextLabel(backend, threadId);
  }

  private notifyForAttentionRequired(event: AgentEvent): void {
    if (!ATTENTION_NOTIFICATION_METHODS.has(event.notification.method)) {
      return;
    }
    const params = event.notification.params as Record<string, unknown>;
    const requestId = params.requestId;
    const threadId = params.threadId;
    if (typeof requestId !== "string" || typeof threadId !== "string") {
      return;
    }
    const isQuestion =
      event.notification.method === "item/tool/requestUserInput";
    const title = isQuestion
      ? "PwrAgent input needed"
      : "PwrAgent approval needed";
    const threadTitle = this.threadInfoStore.get({
      backend: event.backend,
      threadId,
    })?.title;
    const approvalRequest = this.isApprovalAttentionNotification(event.notification)
      ? event.notification
      : undefined;
    const key = `${event.backend}:${threadId}:${requestId}`;
    if (approvalRequest) {
      const intent = buildApprovalIntent({
        createdAt: Date.now(),
        id: key,
        request: approvalRequest,
      });
      intent.requestContext = {
        backend: event.backend,
        method: approvalRequest.method,
        requestId,
        threadId,
        turnId:
          typeof approvalRequest.params.turnId === "string"
            ? approvalRequest.params.turnId
            : undefined,
      };
      try {
        getDesktopNotificationService().notifyApproval({
          enabled: this.notificationsEnabled(),
          key,
          intent,
          onShow: () => {
            requestShowThread({
              backend: event.backend,
              threadId,
            });
          },
          onDecision: (decision) => {
            void this.submitServerRequest({
              backend: event.backend,
              threadId,
              turnId:
                typeof approvalRequest.params.turnId === "string"
                  ? approvalRequest.params.turnId
                  : undefined,
              requestId,
              response: buildPendingRequestResponse(
                approvalRequest,
                pendingRequestDecisionFromMessagingApproval(decision),
              ),
            }).catch((error) => {
              backendRegistryLog.warn("native approval notification decision failed", {
                backend: event.backend,
                error: error instanceof Error ? error.message : String(error),
                requestId,
                threadId,
              });
            });
          },
        });
      } catch (error) {
        backendRegistryLog.warn("native approval notification failed", {
          backend: event.backend,
          error: error instanceof Error ? error.message : String(error),
          requestId,
          threadId,
        });
      }
      return;
    }
    const baseBody = isQuestion
      ? "needs your input"
      : "waiting for your approval";
    const body = threadTitle ? `${threadTitle} · ${baseBody}.` : `A turn ${baseBody}.`;
    try {
      getDesktopNotificationService().notifyAttention({
        enabled: this.notificationsEnabled(),
        key,
        title,
        body,
        onShow: () => {
          requestShowThread({
            backend: event.backend,
            threadId,
          });
        },
      });
    } catch (error) {
      backendRegistryLog.warn("native attention notification failed", {
        backend: event.backend,
        error: error instanceof Error ? error.message : String(error),
        requestId,
        threadId,
      });
    }
  }

  private isApprovalAttentionNotification(
    notification: AgentEvent["notification"],
  ): notification is AppServerPendingRequestNotification {
    return (
      notification.method === "turn/requestApproval" ||
      notification.method === "review/requestApproval" ||
      notification.method === "item/commandExecution/requestApproval" ||
      notification.method === "item/fileChange/requestApproval" ||
      notification.method === "item/permissions/requestApproval" ||
      notification.method === "applyPatchApproval" ||
      notification.method === "execCommandApproval"
    );
  }

  private async notifyForTerminalOutcome(event: AgentEvent): Promise<void> {
    if (event.notification.method === "turn/started") {
      const threadId = (event.notification.params as { threadId?: unknown })
        .threadId;
      if (typeof threadId !== "string") {
        return;
      }
      try {
        getDesktopNotificationService().clearAttentionKey(
          buildTerminalNotificationKey({
            backend: event.backend,
            threadId,
          }),
        );
      } catch (error) {
        backendRegistryLog.warn("native terminal notification cleanup failed", {
          backend: event.backend,
          error: error instanceof Error ? error.message : String(error),
          threadId,
        });
      }
      return;
    }
    if (
      event.notification.method !== "turn/completed" &&
      event.notification.method !== "turn/failed" &&
      event.notification.method !== "turn/cancelled"
    ) {
      return;
    }
    const status =
      event.notification.method === "turn/completed"
        ? "completed"
        : event.notification.method === "turn/failed"
          ? "failed"
          : "cancelled";
    const threadId = (event.notification.params as { threadId?: unknown })
      .threadId;
    const contextLabel =
      typeof threadId === "string"
        ? await this.notificationThreadContextLabelForTerminal(event.backend, threadId)
        : undefined;
    const body = contextLabel
      ? `${contextLabel} · turn ${status}.`
      : `A turn ${status}.`;
    try {
      getDesktopNotificationService().notifyTerminal({
        enabled: this.notificationsEnabled(),
        key:
          typeof threadId === "string"
            ? buildTerminalNotificationKey({
                backend: event.backend,
                threadId,
              })
            : undefined,
        title: `PwrAgent turn ${status}`,
        body,
        onShow:
          typeof threadId === "string"
            ? () => {
                requestShowThread({
                  backend: event.backend,
                  threadId,
                });
              }
            : undefined,
      });
    } catch (error) {
      backendRegistryLog.warn("native terminal notification failed", {
        backend: event.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId,
      });
    }
  }

  private rememberFileChangeApprovalContext(event: AgentEvent): void {
    if (
      event.notification.method !== "item/started" &&
      event.notification.method !== "item/completed"
    ) {
      return;
    }
    const params = readRecord(event.notification.params);
    const item = readRecord(params?.item);
    const itemType = readNonEmptyString(item?.type)?.toLowerCase();
    if (!params || !item || itemType !== "filechange") {
      return;
    }
    const threadId = readNonEmptyString(params.threadId);
    const turnId = readNonEmptyString(params.turnId);
    const itemId = readNonEmptyString(item.id);
    if (!threadId || !itemId) {
      return;
    }

    const files = Array.isArray(item.changes)
      ? item.changes
          .map((change) => readFileChangeApprovalFile(change))
          .filter(
            (
              file,
            ): file is NonNullable<PendingRequestApprovalContext["files"]>[number] =>
              Boolean(file),
          )
      : [];
    if (!files.length) {
      return;
    }

    const primary = files[0]!;
    const context: PendingRequestApprovalContext = {
      ...(primary.action ? { action: primary.action } : {}),
      ...(primary.diff ? { diff: primary.diff } : {}),
      displayPath: primary.displayPath,
      files,
      path: primary.path,
    };
    this.fileChangeApprovalContexts.set(
      fileChangeApprovalContextKey({
        backend: event.backend,
        threadId,
        turnId,
        itemId,
      }),
      context,
    );
    this.fileChangeApprovalContexts.set(
      fileChangeApprovalContextKey({
        backend: event.backend,
        threadId,
        turnId,
      }),
      context,
    );
    if (this.fileChangeApprovalContexts.size > 500) {
      const oldestKey = this.fileChangeApprovalContexts.keys().next().value;
      if (oldestKey) {
        this.fileChangeApprovalContexts.delete(oldestKey);
      }
    }
  }

  private withEmbeddedFileChangeApprovalContext(event: AgentEvent): AgentEvent {
    if (event.notification.method !== "item/fileChange/requestApproval") {
      return event;
    }
    const request = event.notification as AppServerPendingRequestNotification;
    if (request.params._pwragentApprovalContext) {
      return event;
    }
    const threadId = readNonEmptyString(request.params.threadId);
    const turnId = readNonEmptyString(request.params.turnId);
    const itemId =
      readNonEmptyString(request.params.itemId) ??
      readNonEmptyString(request.params.item_id) ??
      readNonEmptyString(request.params.callId) ??
      readNonEmptyString(request.params.call_id);
    if (!threadId) {
      return event;
    }
    const context =
      (itemId
        ? this.fileChangeApprovalContexts.get(
            fileChangeApprovalContextKey({
              backend: event.backend,
              threadId,
              turnId,
              itemId,
            }),
          )
        : undefined) ??
      this.fileChangeApprovalContexts.get(
        fileChangeApprovalContextKey({
          backend: event.backend,
          threadId,
          turnId,
        }),
      );
    if (!context) {
      return event;
    }

    return {
      ...event,
      notification: {
        ...request,
        params: {
          ...request.params,
          _pwragentApprovalContext: context,
        },
      } as AppServerPendingRequestNotification,
    };
  }

  withThreadWorkspaceMutation<T>(
    identity: { backend: AppServerBackendKind; threadId: string },
    work: () => Promise<T>,
    paths?: readonly string[],
  ): Promise<T> {
    return this.threadArchiveCoordinator.withThreadWorkspaceMutation(identity, work, paths);
  }

  withArchiveWorkspaceWrite<T>(paths: readonly string[], work: () => Promise<T>): Promise<T> {
    return this.threadArchiveCoordinator.withArchiveWorkspaceWrite(paths, work);
  }

  private readonly transcriptImageWork = new Map<string, Promise<void>>();

  private emitWithTranscriptImages(event: AgentEvent, codexStatusSequence?: number, codexStartDelivery?: CodexStartDeliveryReceipt): Promise<void> {
    const notification = event.notification;
    if (!("threadId" in notification.params) || typeof notification.params.threadId !== "string") return this.emitEvent(event, codexStatusSequence, codexStartDelivery);
    const threadId = notification.params.threadId;
    const key = `${event.backend}:${threadId}`;
    const previous = this.transcriptImageWork.get(key);
    const item = notification.method === "item/completed" ? readRecord(notification.params.item) : undefined;
    const materializeImages = item?.type === "agentMessage" || item?.type === "imageView"
      || item?.type === "mcpToolCall" || item?.type === "dynamicToolCall";
    // Keep lifecycle bookkeeping (including queue release) and subsequent
    // transcript events behind image work, in arrival order. Extend the chain
    // through delivery, so idle or the next turn cannot overtake a held terminal.
    const orderedNotification = notification.method.startsWith("turn/")
      || notification.method === "thread/status/changed"
      || notification.method.startsWith("item/");
    if (!materializeImages && (!previous || !orderedNotification)) {
      return this.emitEvent(event, codexStatusSequence, codexStartDelivery);
    }
    const work = (async () => {
      await previous?.catch(() => undefined);
      const materialized = materializeImages ? await materializeTranscriptImageEventForRenderer(event, {}, {
        includeTemporaryImageRoots: true,
        resolveApprovedLocalImageRoots: async () => await this.getThreadTranscriptImageRoots({
          backend: event.backend, threadId,
        }),
      }).catch((error) => {
        backendRegistryLog.warn("live transcript image materialization failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return event;
      }) : event;
      await this.emitEvent(materialized, codexStatusSequence, codexStartDelivery);
    })();
    this.transcriptImageWork.set(key, work);
    void work.finally(() => {
      if (this.transcriptImageWork.get(key) === work) this.transcriptImageWork.delete(key);
    }).catch(() => undefined);
    return work;
  }

  private async emit(event: AgentEvent, codexStatusSequence?: number, codexStartDelivery?: CodexStartDeliveryReceipt): Promise<void> {
    const notification = event.notification;
    const isTerminal = notification.method === "turn/completed"
      || notification.method === "turn/failed" || notification.method === "turn/cancelled";
    const terminalDelivery = isTerminal ? Promise.withResolvers<void>() : undefined;
    // Register before observers can unregister the turn, and before any
    // await so a shutdown starting mid-delivery can still drain it.
    if (terminalDelivery) this.pendingTerminalEmits.add(terminalDelivery.promise);
    const ownedStartDelivery = !codexStartDelivery && event.backend === "codex" && notification.method === "turn/started"
      ? this.context.turnState.beginStartDelivery(notification.params.threadId, turnIdFromStartedNotification(notification as Extract<AppServerNotification, { method: "turn/started" }>))
      : undefined;
    codexStartDelivery ??= ownedStartDelivery;
    try {
      if (event.backend === "codex") {
        if (isTerminal) {
          this.context.turnState.observeTurnTerminal(notification.params.threadId, turnIdFromTerminalNotification(notification));
        }
        const params = readRecord(event.notification.params);
        const threadId = readOptionalString(params, ["threadId"]);
        const turnId = readOptionalString(params, ["turnId"])
          ?? readOptionalString(readRecord(params?.turn), ["id"]);
        if (threadId && turnId && !isPendingTurnId(threadId, turnId)) {
          let turns = this.codexMessageContextTurnObservations.get(threadId);
          if (!turns) {
            turns = new Map();
            this.codexMessageContextTurnObservations.set(threadId, turns);
          }
          // Keep the first observation at ingress: delayed repeats must not
          // turn an earlier identity into one admitted by a later start.
          if (!turns.has(turnId)) turns.set(turnId, ++this.codexMessageContextTurnSequence);
        }
      }
      this.navigationDirectoryScope.invalidate(event);
      const archiveWorkspaceChanged = this.threadArchiveCoordinator.invalidateArchiveCleanupForNotification(event.backend, event.notification);
      const archiveReferences = this.threadArchiveCoordinator.prepareArchiveReferenceChanges(event.backend, event.notification);
      if (archiveWorkspaceChanged && this.threadArchiveCoordinator.archiveWorktreeRemovalAdmissionRecords.size) await this.threadArchiveCoordinator.prepareArchiveWorkspaceChanges(event.backend, event.notification, archiveWorkspaceChanged);
      if (archiveReferences) await archiveReferences;
      if (event.notification.method === "navigation/threadDirectories/updated") {
        // Managed local MCP servers in these threads are told their roots moved.
        const threadIds = readRecord(event.notification.params)?.threadIds;
        if (Array.isArray(threadIds)) {
          this.mcpConnectionService?.noteThreadDirectoriesChanged?.(
            event.backend,
            threadIds.filter((threadId): threadId is string => typeof threadId === "string"),
          );
        }
      }
      if (event.notification.method === "thread/deleted") {
        this.invalidateThreadListCache(event.backend);
        if (!this.closed) void this.sweepInactiveThreads({ manual: false });
      }
      const emitted = event.notification.method === "thread/deleted"
        ? this.deleteOwnedThreadAssets({ backend: event.backend, threadId: event.notification.params.threadId })
            .catch((error) => backendRegistryLog.warn("thread asset cleanup failed", { error: error instanceof Error ? error.message : String(error) }))
            .then(() => this.emitWithTranscriptImages(event, codexStatusSequence, codexStartDelivery))
        : this.emitWithTranscriptImages(event, codexStatusSequence, codexStartDelivery);
      return await emitted;
    } finally {
      if (terminalDelivery) {
        this.pendingTerminalEmits.delete(terminalDelivery.promise);
        terminalDelivery.resolve();
      }
      if (ownedStartDelivery) this.context.turnState.endStartDelivery(ownedStartDelivery);
    }
  }

  private emitEvent(event: AgentEvent, codexStatusSequence?: number, codexStartDelivery?: CodexStartDeliveryReceipt): Promise<void> {
    this.codexRuntimeSupervisor.trackLiveCodexToolItem(event);
    if (event.backend === "codex" && event.notification.method === "turn/started") {
      const notification = event.notification as {
        params: { threadId: string; turnId?: string; turn: { id: string } };
      };
      this.tokenMiserStore?.startTurn(
        notification.params.threadId,
        turnIdFromStartedNotification(notification),
      );
    }
    // Capture ownership before terminal handling removes the monitor record.
    // Keep protocol IDs intact for accounting, recovery, and lifecycle consumers.
    if (
      event.notification.method === "error"
      || event.notification.method === "warning"
      || event.notification.method === "turn/completed"
      || event.notification.method === "turn/cancelled"
      || event.notification.method === "turn/failed"
      || (event.notification.method === "thread/status/changed"
        && readStatusType(event.notification.params.status) === "systemError")
    ) {
      const threadId = readOptionalString(event.notification.params.threadId);
      if (threadId) {
        const monitor = this.subAgentMonitorService.taskMonitorForThread({ backend: event.backend, threadId })
          ?? this.subAgentMonitorService.completedTaskMonitorRecords.get(taskMonitorThreadKey(event.backend, threadId));
        const owner = this.subAgentMonitorService.resolveSubAgentThreadOwner({
          backend: event.errorNoticeContext?.backend ?? event.backend,
          threadId: event.errorNoticeContext?.threadId ?? threadId,
        });
        const automation = this.headlessAutomation.headlessAutomationErrorNoticeContext(owner.backend, owner.threadId);
        const backend = automation?.backend ?? owner.backend;
        const ownerThreadId = automation?.threadId ?? owner.threadId;
        const title = automation?.title ?? event.errorNoticeContext?.title
          ?? this.getCachedThreadSummary({ backend, threadId: ownerThreadId })?.title;
        const automationName = automation?.automationName ?? event.errorNoticeContext?.automationName;
        // Ordinary retries and successful terminal events retain their provider
        // envelope. Failure surfaces already used same-thread notice context.
        if (owner.isSubAgent || automation || event.errorNoticeContext
          || event.notification.method === "turn/failed"
          || event.notification.method === "thread/status/changed") {
          event = {
            ...event,
            errorNoticeContext: {
              backend,
              threadId: ownerThreadId,
              ...(title ? { title } : {}),
              ...(event.errorNoticeContext?.taskMonitor || monitor
                ? { taskMonitor: true }
                : {}),
              ...(automationName ? { automationName } : {}),
            },
          };
        }
      }
    }
    event = this.withStreamNoticeRecoveryContext(event);
    this.threadUsageLedger.trackRecentThreadUsageTurn(event);
    const isLiveThreadUsage =
      event.notification.method === "thread/tokenUsage/updated";
    if (isLiveThreadUsage && this.closed) {
      return Promise.resolve();
    }
    const liveThreadUsageWork =
      event.notification.method === "thread/tokenUsage/updated"
        ? this.threadUsageLedger.registerLiveThreadUsageEmitWork(
            event.backend,
            event.notification.params.threadId,
          )
        : undefined;
    const method = event.notification.method;
    const precedingLiveThreadUsageBarrier =
      method === "turn/completed"
      || method === "turn/failed"
      || method === "turn/cancelled"
        ? this.threadUsageLedger.waitForLiveThreadUsageEmitWork()
        : undefined;
    const emitted = this.turnEventObservers.run(
      event,
      liveThreadUsageWork,
      precedingLiveThreadUsageBarrier,
      codexStatusSequence,
      codexStartDelivery,
    );
    return liveThreadUsageWork
      ? emitted.finally(() => {
          // Earlier pipeline stages may reject before usage derivation. Always
          // release the terminal/close barrier; the successful path finishes
          // before listener fan-out to avoid a listener-driven close deadlock.
          this.threadUsageLedger.finishLiveThreadUsageEmitWork(liveThreadUsageWork);
        })
      : emitted;
  }

  private withStreamNoticeRecoveryContext(event: AgentEvent): AgentEvent {
    const { method, params } = event.notification;
    const progress = method === "item/agentMessage/delta"
      || method === "item/reasoning/textDelta"
      || method === "item/reasoning/summaryTextDelta"
      || method === "item/plan/delta";
    const terminal = method === "turn/completed"
      || method === "turn/failed"
      || method === "turn/cancelled";
    if (!progress && !terminal && method !== "error" && method !== "thread/deleted") return event;
    const threadId = readNonEmptyString(params.threadId);
    if (!threadId) return event;
    const threadKey = JSON.stringify([
      event.federationTarget?.scope === "remote" ? event.federationTarget.instanceId : null,
      event.backend, threadId,
    ]);
    if (method === "thread/deleted") {
      this.streamNoticeOwners.delete(threadKey);
      return event;
    }
    const turnId = readNonEmptyString(readRecord(params)?.turnId) ?? "";
    let turns = this.streamNoticeOwners.get(threadKey);
    if (method === "error" && event.errorNoticeContext) {
      if (!turns) {
        turns = new Map();
        this.streamNoticeOwners.set(threadKey, turns);
      }
      turns.set(turnId, event.errorNoticeContext);
    } else if (progress && readNonEmptyString(readRecord(params)?.delta)) {
      // Sparse parent viewers must see recovery on the first model delta.
      // Resolve ownership only at the error boundary, never per streamed token.
      const owner = turns?.get(turnId);
      if (owner && turns) {
        turns.delete(turnId);
        if (turns.size === 0) this.streamNoticeOwners.delete(threadKey);
        return { ...event, errorNoticeContext: owner };
      }
    } else if (terminal && turns) {
      turns.delete(turnId);
      if (turns.size === 0) this.streamNoticeOwners.delete(threadKey);
    }
    return event;
  }

  private async observeTurnMessageContext(delivery: TurnEventDelivery): Promise<void> {
    delivery.event = await this.withThreadMessageContext(delivery.event);
    this.rememberFileChangeApprovalContext(delivery.event);
    delivery.event = this.withEmbeddedFileChangeApprovalContext(delivery.event);
  }

  private async observeTurnThreadState(delivery: TurnEventDelivery): Promise<void> {
    const { event } = delivery;
    if (event.backend === "codex" && event.notification.method === "thread/name/updated") {
      const { threadId, threadName, titleSource } = event.notification.params;
      if (typeof threadName === "string" && threadName.trim()) {
        const source = normalizeRenamedTitleSource(titleSource);
        const identity = { backend: "codex" as const, threadId };
        const metadata = source === "explicit" ? await this.overlayStore.getThreadMetadata?.(identity) : undefined;
        // The provider already persists ordinary explicit names. Retain owner
        // provenance for derived titles and replace any earlier canonical title
        // so a pending import cannot overwrite this acknowledged rename.
        if (source !== "explicit" || metadata?.title !== undefined) {
          await this.overlayStore.updateThreadMetadata?.(identity, {
            title: { text: threadName.trim(), source, nativeName: threadName.trim() },
          });
        }
      }
    }
    if (event.backend !== "codex" && event.notification.method === "thread/name/updated") {
      const { threadId, threadName, titleSource } = event.notification.params;
      const snapshot = this.providerThreadSnapshotStore?.list().find(value => value.backend === event.backend);
      const thread = snapshot?.threads.find(value => value.id === threadId);
      const source = titleSource === undefined ? thread?.titleSource ?? "fallback" : normalizeRenamedTitleSource(titleSource);
      // A name event updates an already discovered provider row. It cannot
      // manufacture a complete inventory for an undiscovered provider.
      if (snapshot && thread && typeof threadName === "string" && threadName.trim()
        && (thread.title !== threadName.trim() || thread.titleSource !== source)) {
        this.providerThreadSnapshotStore?.replace({ ...snapshot,
          threads: snapshot.threads.map(value => value.id === threadId
            ? { ...value, title: threadName.trim(), titleSource: source } : value),
        });
      }
    }
    this.rememberThreadTitleFromEvent(event);
    if (this.shouldInvalidateThreadListCacheForNotification(event.notification.method)) {
      // Reconciled turn status does not certify the provider's activity timestamp.
      this.invalidateThreadListCache(event.backend);
    }

    if (
      event.backend === "codex" &&
      event.notification.method === "thread/status/changed"
    ) {
      this.reconcileBackendCodexThreadStatus(
        event.notification.params.threadId,
        readStatusType(event.notification.params.status),
      );
    }

    if (
      event.backend === "codex" &&
      event.notification.method === "thread/status/changed" &&
      readStatusType(event.notification.params.status) === "active"
    ) {
      this.schedulePendingThreadTitleGenerationFromLifecycle({
        backend: event.backend,
        threadId: event.notification.params.threadId,
      });
    }

    if (
      event.backend === "codex" &&
      event.notification.method === "configWarning"
    ) {
      this.latestCodexConfigWarning = event;
    }
  }

  private async observeTurnStarted(delivery: TurnEventDelivery): Promise<void> {
    const { event, codexStatusSequence, codexStartDelivery } = delivery;
    if (event.notification.method === "turn/started") {
      const notification = event.notification as {
        params: {
          threadId: string;
          turnId?: string;
          turn: {
            id: string;
          };
        };
      };
      const turnId = turnIdFromStartedNotification(notification);
      const commitCodexStart = event.backend !== "codex" || !codexStartDelivery
        || this.context.turnState.canCommitStart(codexStartDelivery);
      if (event.backend === "codex" && commitCodexStart) {
        this.reconcileBackendCodexThreadStatus(
          notification.params.threadId,
          "active",
          codexStatusSequence,
        );
      }
      if (!isAcpBackendId(event.backend)) {
        this.schedulePendingThreadTitleGenerationFromLifecycle({
          backend: event.backend,
          threadId: notification.params.threadId,
        });
      }
      if (commitCodexStart) this.context.turnState.registerTurn(
        { backend: event.backend, threadId: notification.params.threadId, turnId: turnId },
        codexStartDelivery,
      );
      if (isAcpBackendId(event.backend)) {
        backendRegistryLog.info("ACP active turn registered", {
          backend: event.backend,
          threadId: notification.params.threadId,
          turnId,
        });
      }
      if (event.backend === "codex" && commitCodexStart) {
        const pendingTurnId = buildPendingTurnId(notification.params.threadId);
        const pendingActiveKey = buildActiveTurnKey("codex", notification.params.threadId, pendingTurnId);
        const pendingModeKey = buildActiveTurnModeKey(notification.params.threadId, pendingTurnId);
        const collaborationMode = this.context.turnState.collaborationMode(
          pendingActiveKey,
        );
        const pendingMode = collaborationMode ? this.context.turnState.executionMode(pendingModeKey) : undefined;
        if (collaborationMode) {
          this.context.turnState.setCollaboration(
            { backend: "codex", threadId: notification.params.threadId, turnId: turnId }, collaborationMode,
          );
        }
        const key = buildActiveTurnModeKey(
          notification.params.threadId,
          turnId,
        );
        const activeReviewTurnKey = this.findActiveCodexReviewTurnKey(
          notification.params.threadId,
        );
        if (activeReviewTurnKey && activeReviewTurnKey !== key) {
          this.context.turnState.setReviewInterrupt(activeReviewTurnKey, turnId);
        }
        if (!this.context.turnState.ownsExecution(key)) {
          const registration = this.context.turnState.registration(key);
          const mode = pendingMode ?? await this.resolveCodexThreadExecutionModeForActiveTurn(
            notification.params.threadId,
          );
          // Terminal delivery can remove this turn while the overlay read is
          // pending. A finished turn must never regain execution-mode ownership.
          if (registration !== undefined) this.context.turnState.resolveExecution(key, registration, mode);
        }
        if (collaborationMode && turnId !== pendingTurnId) {
          // Transfer ownership before removing the placeholder and its guard.
          this.context.turnState.forgetExecution(pendingModeKey);
          this.context.turnState.unregisterTurn(pendingActiveKey);
          this.context.turnState.forgetCollaboration(pendingActiveKey);
        }
      }
    }
  }

  private async observeTurnTerminalRequests(delivery: TurnEventDelivery): Promise<void> {
    const event = delivery.event as AgentEvent & { notification: Extract<AppServerNotification, { method: "turn/completed" | "turn/failed" | "turn/cancelled" }> };
    const completedTurnId = turnIdFromTerminalNotification(event.notification);
    if (completedTurnId) {
      for (const pending of this.pendingThreadMessageContexts.values()) {
        if (pending.backend === event.backend
          && pending.threadId === event.notification.params.threadId
          && pending.turnId === completedTurnId) {
          // Turn completion does not confirm admission or cancellation of
          // an accepted steer. Keep attribution for delayed user items.
          pending.turnEnded = true;
        }
      }
      // An MCP elicitation cannot keep its provider turn alive after that
      // turn ends. Retaining it lets a later read resurrect the ended turn.
      // A turn the operator did not stop ended on the agent's own word, so
      // they may still be looking for a card the agent pointed them at.
      const endedWithoutOperator = event.notification.method === "turn/failed"
        || (event.notification.method === "turn/completed"
          && readRecord(readRecord(event.notification.params)?.turn)?.status === "completed");
      const withdrawnForgeApprovals: AppServerPendingRequestNotification[] = [];
      for (const [key, pending] of this.pendingServerRequests) {
        const request = pending.notification;
        const owner = pending.owner ?? { backend: pending.backend, threadId: request.params.threadId, turnId: request.params.turnId };
        if (owner.backend !== event.backend
          || owner.threadId !== event.notification.params.threadId
          || owner.turnId !== completedTurnId
          || request.method !== "mcpServer/elicitation/request") {
          continue;
        }
        if (endedWithoutOperator && String(request.params.requestId).startsWith(FORGE_TOOL_REQUEST_ID_PREFIX)) {
          withdrawnForgeApprovals.push(request);
        }
        this.pendingServerRequests.delete(key);
        pending.resolve({ action: "cancel", content: null, _meta: null });
        await this.emit({ backend: pending.backend, notification: {
          method: "serverRequest/resolved", params: {
            threadId: request.params.threadId, turnId: request.params.turnId,
            requestId: request.params.requestId,
          },
        } });
      }
      delivery.withdrawnForgeApprovals = withdrawnForgeApprovals;
    }
  }

  private observeTurnTerminalResources(delivery: TurnEventDelivery): void {
    const event = delivery.event as AgentEvent & { notification: Extract<AppServerNotification, { method: "turn/completed" | "turn/failed" | "turn/cancelled" }> };
    const { codexStatusSequence } = delivery;
    const turnId = turnIdFromTerminalNotification(event.notification);
    const notification = event.notification;
    if (turnId) {
      this.pdfAttachmentStore.releaseTurn({
        backend: event.backend,
        threadId: notification.params.threadId,
        turnId,
      });
    }
    if (event.backend === "codex") {
      this.reconcileBackendCodexThreadStatus(
        notification.params.threadId,
        "idle",
        // A synthetic failure belongs to its start's observation. A newer
        // provider status must not become idle because submission failed.
        codexStatusSequence,
      );
    }
  }

  private async observeTurnTerminalActivity(delivery: TurnEventDelivery): Promise<void> {
    const event = delivery.event as AgentEvent & { notification: Extract<AppServerNotification, { method: "turn/completed" | "turn/failed" | "turn/cancelled" }> };
    const turnId = turnIdFromTerminalNotification(event.notification);
    const notification = event.notification;
    const { managedReview } = delivery;
    const genericActiveTurnKeyPrefix =
      `${event.backend}:${notification.params.threadId}:`;
    const hadGenericActiveTurn = Array.from(this.context.turnState.registeredTurnKeys()).some((key) =>
      key.startsWith(genericActiveTurnKeyPrefix),
    );
    const hadMatchingGenericActiveTurn = turnId !== undefined
      && this.context.turnState.hasRegisteredTurn({ backend: event.backend, threadId: notification.params.threadId, turnId: turnId });
    if (turnId) {
      if (isAcpBackendId(event.backend)) {
        for (const key of Array.from(this.context.turnState.registeredTurnKeys())) {
          if (key.startsWith(genericActiveTurnKeyPrefix)) {
            this.context.turnState.unregisterTurn(key);
            const parsed = parseActiveTurnKey(key);
            backendRegistryLog.info("ACP active turn removed", {
              backend: event.backend,
              threadId: notification.params.threadId,
              turnId: parsed?.turnId ?? null,
              method: event.notification.method,
              completedTurnId: turnId,
            });
            if (parsed) {
              this.clearAcceptedToolCallsForEndedTurn(parsed.backend, parsed.threadId, parsed.turnId);
            }
          }
        }
      } else {
        this.context.turnState.unregisterTurn(
          { backend: event.backend, threadId: notification.params.threadId, turnId: turnId },
        );
      }
      this.clearAcceptedToolCallsForEndedTurn(event.backend, notification.params.threadId, turnId);
      this.threadSteering.retireTurn({
        backend: event.backend,
        threadId: notification.params.threadId,
        turnId,
      });
    }
    if ((event.backend === "claude" && hadMatchingGenericActiveTurn)
      || (isAcpBackendId(event.backend) && hadGenericActiveTurn)) {
      await this.adoptThreadBranchChangeFromActiveTurn({
        backend: event.backend,
        threadId: notification.params.threadId,
      });
    }
    if (event.backend === "codex" && turnId) {
      const activeTurnModeKey = buildActiveTurnModeKey(
        notification.params.threadId,
        turnId,
      );
      const wasKnownActiveTurn =
        !turnId.startsWith("pending:") &&
        this.context.turnState.ownsExecution(activeTurnModeKey);
      if (managedReview?.mode === "native") {
        this.managedReviewService.clearNativeReviewActiveTurns(managedReview);
      }
      this.clearCodexReviewInterruptMappingForTurn(
        notification.params.threadId,
        turnId,
      );
      this.context.turnState.forgetExecution(activeTurnModeKey);
      // The start response can register a turn whose started notification was absent.
      this.context.turnState.forgetCollaboration(
        { backend: "codex", threadId: notification.params.threadId, turnId: turnId },
      );
      this.context.turnState.forgetReview(activeTurnModeKey);
      if (wasKnownActiveTurn) {
        await this.adoptThreadBranchChangeFromActiveTurn({
          backend: event.backend,
          threadId: notification.params.threadId,
        });
      }
      try {
        const overlay = await this.overlayStore.getThreadOverlayState({
          backend: event.backend,
          threadId: notification.params.threadId,
        });
        const observedSettings = this.observedCodexSettingsByThread.get(
          notification.params.threadId,
        );
        const warning = getCodexFastModeMismatchWarning({
          threadId: notification.params.threadId,
          turnId,
          expectedFastMode: Boolean(overlay?.fastMode),
          notificationParams: buildCodexFastModeMismatchNotificationParams(
            notification.params,
            observedSettings,
          ),
        });
        if (warning) {
          backendRegistryLog.warn("codex fast mode state mismatch", warning);
        }
      } catch (error) {
        backendRegistryLog.warn("codex fast mode state mismatch check failed", {
          error: error instanceof Error ? error.message : String(error),
          threadId: notification.params.threadId,
          turnId,
        });
      }
    }
  }

  private async observeTurnTerminalModes(delivery: TurnEventDelivery): Promise<void> {
    const event = delivery.event as AgentEvent & { notification: Extract<AppServerNotification, { method: "turn/completed" | "turn/failed" | "turn/cancelled" }> };
    const notification = event.notification;
    if (event.backend === "codex") {
      // Turn-end is the resume boundary — flush any queued mode change
      // now. Fire-and-forget so terminal turn fan-out does not block on
      // permission prompts; startTurn/startReview also await any in-flight
      // flush before launching the next Codex request.
      // Failures are logged + retried inside
      // flushQueuedExecutionModeIfPresent.
      this.scheduleQueuedAgentChange(notification.params.threadId);
      void this.flushQueuedExecutionModeIfPresent(
        notification.params.threadId,
      );
    } else if (isAcpBackendId(event.backend)) {
      if (this.usesSlashControlledAcpExecutionModes(event.backend)) {
        await this.flushQueuedExecutionModeIfPresent(
          notification.params.threadId,
          event.backend,
        );
      }
      await this.acpSessionRuntimeOptions.flushQueuedAcpRuntimeOptionIfPresent(
        event.backend,
        notification.params.threadId,
      );
      if (event.notification.method !== "turn/completed") {
        this.threadTitles.forgetPendingInput({ backend: event.backend, threadId: notification.params.threadId });
      }
    }
  }

  private async observeTurnTerminalQueue(delivery: TurnEventDelivery): Promise<void> {
    const event = delivery.event as AgentEvent & { notification: Extract<AppServerNotification, { method: "turn/completed" | "turn/failed" | "turn/cancelled" }> };
    const notification = event.notification;
    const { lifecycleTurnId } = delivery;
    const release = () => this.threadTurnQueue.releaseThread({
      backend: event.backend,
      threadId: notification.params.threadId,
      turnId: lifecycleTurnId,
      status: event.notification.method,
      ...(event.notification.method === "turn/failed"
        ? {
            errorMessage:
              errorMessageFromTerminalNotification(event.notification)
              ?? "The previous turn failed.",
          }
        : {}),
    });
    const afterDelivery = delivery.afterDelivery;
    if (afterDelivery) {
      delivery.afterDelivery = async () => {
        await afterDelivery();
        void release();
      };
    } else {
      void release();
    }
  }

  private async observeTurnFailure(delivery: TurnEventDelivery): Promise<void> {
    const { event } = delivery;
    if (
      event.notification.method === "turn/failed" &&
      !isAcpBackendId(event.backend)
    ) {
      // Persist a durable failure marker BEFORE the renderer fan-out below
      // so the next navigation-snapshot refresh carries it. Dedupe lives in
      // the overlay store (by turnId). ACP backends are skipped: their
      // session normalizer already persists a `turn-failed:` transcript
      // entry that readThread returns, so recording here would just be
      // redundant overlay state (the renderer would de-dupe it anyway).
      // Params are cast explicitly here, matching the surrounding terminal-
      // notification handlers — the `AppServerNotification` union is too
      // wide for reliable narrowing.
      const failureParams = event.notification.params as {
        threadId: string;
        turnId: string;
        turn?: { error?: { message?: unknown } };
      };
      const rawMessage = failureParams.turn?.error?.message;
      const errorMessage =
        typeof rawMessage === "string" && rawMessage.trim()
          ? rawMessage
          : "Turn failed.";
      await this.appendTurnFailure({
        backend: event.backend,
        threadId: failureParams.threadId,
        failure: {
          id: randomUUID(),
          turnId: failureParams.turnId,
          error: errorMessage,
          occurredAt:
            completedAtFromTerminalNotification(event.notification) ??
            Date.now(),
        },
      });
    }
  }

  private async observeTurnStatus(delivery: TurnEventDelivery): Promise<void | false> {
    const { event } = delivery;
    if (
      event.notification.method === "thread/status/changed" &&
      readStatusType(event.notification.params.status) !== "active"
    ) {
      const threadId = event.notification.params.threadId;
      const hasActiveCodexReviewTurn =
        event.backend === "codex" &&
        this.threadHasActiveCodexReviewTurn(threadId);
      const endedTurnIds = new Set<string>();
      const genericKeyPrefix = `${event.backend}:${event.notification.params.threadId}:`;
      let hadGenericActiveTurn = false;
      for (const key of Array.from(this.context.turnState.registeredTurnKeys())) {
        if (key.startsWith(genericKeyPrefix)) {
          const parsed = parseActiveTurnKey(key);
          if (
            hasActiveCodexReviewTurn &&
            parsed?.backend === "codex" &&
            this.context.turnState.isReview(
              { threadId: parsed.threadId, turnId: parsed.turnId },
            )
          ) {
            continue;
          }
          hadGenericActiveTurn = true;
          if (parsed?.turnId && !parsed.turnId.startsWith("pending:")) {
            endedTurnIds.add(parsed.turnId);
          }
          this.context.turnState.unregisterTurn(key);
          if (isAcpBackendId(event.backend)) {
            backendRegistryLog.info("ACP active turn removed", {
              backend: event.backend,
              threadId,
              turnId: parsed?.turnId ?? null,
              method: event.notification.method,
              status: readStatusType(event.notification.params.status),
            });
          }
          if (parsed) {
            this.clearAcceptedToolCallsForEndedTurn(parsed.backend, parsed.threadId, parsed.turnId);
          }
        }
      }
      if (event.backend !== "codex") {
        if (hadGenericActiveTurn) {
          await this.adoptThreadBranchChangeFromActiveTurn({
            backend: event.backend,
            threadId: event.notification.params.threadId,
          });
        }
        if (isAcpBackendId(event.backend)) {
          if (this.usesSlashControlledAcpExecutionModes(event.backend)) {
            await this.flushQueuedExecutionModeIfPresent(
              event.notification.params.threadId,
              event.backend,
            );
          }
          await this.acpSessionRuntimeOptions.flushQueuedAcpRuntimeOptionIfPresent(
            event.backend,
            event.notification.params.threadId,
          );
        }
      } else {
        const keyPrefix = `${event.notification.params.threadId}:`;
        let hadKnownActiveTurn = false;
        for (const key of this.context.turnState.executionKeys()) {
          if (key.startsWith(keyPrefix)) {
            if (this.context.turnState.isReview(key)) {
              continue;
            }
            if (!key.startsWith(`${keyPrefix}pending:`)) {
              hadKnownActiveTurn = true;
            }
            const parsed = parseThreadTurnKeyBody(key);
            if (parsed?.turnId && !parsed.turnId.startsWith("pending:")) {
              endedTurnIds.add(parsed.turnId);
            }
            this.context.turnState.forgetExecution(key);
            if (parsed) {
              this.context.turnState.forgetCollaboration(
                { backend: "codex", threadId: parsed.threadId, turnId: parsed.turnId },
              );
              this.clearAcceptedToolCallsForEndedTurn(event.backend, parsed.threadId, parsed.turnId);
            }
          }
        }
        if (hadKnownActiveTurn) {
          await this.adoptThreadBranchChangeFromActiveTurn({
            backend: event.backend,
            threadId: event.notification.params.threadId,
          });
        }
        // Same resume-boundary flush, triggered from the
        // `thread/status/changed → idle` path (codex emits both, depending
        // on the protocol shape; we cover both for resilience). Idempotent
        // when no queue is set.
        if (!hasActiveCodexReviewTurn) {
          this.scheduleQueuedAgentChange(event.notification.params.threadId);
          await this.flushQueuedExecutionModeIfPresent(
            event.notification.params.threadId,
          );
        }
      }
      if (hasActiveCodexReviewTurn) {
        // Codex review/start currently returns the real review turn id, then
        // may emit a mismatched turn/started and an idle status before the
        // review's own terminal event. Do not release queued turns at that
        // stray idle boundary; the matching review turn/completed is the real
        // point where the thread becomes available again.
        return false;
      }
      delivery.endedTurnIds = endedTurnIds;
    }
  }

  private observeTurnStatusQueue(delivery: TurnEventDelivery): void {
    const { event } = delivery;
    if (event.notification.method !== "thread/status/changed" || !delivery.endedTurnIds) return;
    void this.threadTurnQueue.releaseThread({
      backend: event.backend,
      threadId: event.notification.params.threadId,
      status: readStatusType(event.notification.params.status),
    });
  }

  private observeTurnRequestResolution(delivery: TurnEventDelivery): void | false {
    const { event } = delivery;
    if (event.notification.method === "serverRequest/resolved") {
      const key = buildPendingRequestKey({
        backend: event.backend,
        threadId: event.notification.params.threadId,
        requestId: event.notification.params.requestId,
      });
      if (this.pendingServerRequests.has(key)) {
        backendRegistryLog.warn(
          "serverRequest/resolved received while request is still pending; ignoring premature resolution",
          {
            backend: event.backend,
            threadId: event.notification.params.threadId,
            requestId: event.notification.params.requestId,
          },
        );
        return false;
      }
      try {
        getDesktopNotificationService().clearAttentionKey(key);
      } catch (error) {
        backendRegistryLog.warn("native notification cleanup failed", {
          backend: event.backend,
          error: error instanceof Error ? error.message : String(error),
          requestId: event.notification.params.requestId,
          threadId: event.notification.params.threadId,
        });
      }
    }
  }

  private async observeTurnNotifications(delivery: TurnEventDelivery): Promise<void> {
    const { event } = delivery;
    this.notifyForAttentionRequired(event);
    await this.notifyForTerminalOutcome(event);
  }

  private async observeTurnListeners(delivery: TurnEventDelivery): Promise<void> {
    delivery.event = { ...delivery.event, navigationDirectoryScope: this.navigationDirectoryScope.forEvent(delivery.event) };
    await this.emitToListeners(delivery.event);
  }

  /**
   * Fan an event out to subscribers without running any of `emit`'s recording
   * stages. Only for events that are a *view* of something already recorded —
   * managed-review forwarding and coalesced rate-limit cache broadcasts use
   * this path. Running managed-review views through `emit` would re-execute
   * the whole pipeline against the parent thread id, which double-counts tool
   * accounting (a sqlite write per item) and pollutes the file-change
   * approval-context cache. Rate-limit broadcasts have no thread recording
   * semantics and likewise belong only at the listener boundary.
   */
  private async emitToListeners(event: AgentEvent): Promise<void> {
    for (const listener of this.eventListeners) {
      try {
        await listener(event);
      } catch (error) {
        backendRegistryLog.error("desktop event listener failed", {
          backend: event.backend,
          error: error instanceof Error ? error.message : String(error),
          method: event.notification.method,
          requestId:
            "requestId" in event.notification.params
              ? event.notification.params.requestId
              : undefined,
          threadId:
            "threadId" in event.notification.params
              ? event.notification.params.threadId
              : undefined,
          turnId:
            "turnId" in event.notification.params
              ? event.notification.params.turnId
              : undefined,
        });
      }
    }
  }
}

let registry: DesktopBackendRegistry | null = null;

export function getExistingDesktopBackendRegistry(): DesktopBackendRegistry | null {
  return registry;
}

/** The root supplies construction; singleton readers never compose owners. */
export function initializeDesktopBackendRegistry(create: () => DesktopBackendRegistry): DesktopBackendRegistry {
  registry ??= create();
  return registry;
}

export async function disposeDesktopBackendRegistry(): Promise<void> {
  if (!registry) {
    return;
  }

  const current = registry;
  registry = null;
  await current.close();
}

/** Only startOwnerServices constructs the process owner. */
export function getDesktopBackendRegistry(): DesktopBackendRegistry {
  if (!registry) throw new Error("getDesktopBackendRegistry is unavailable before startOwnerServices().");
  return registry;
}
