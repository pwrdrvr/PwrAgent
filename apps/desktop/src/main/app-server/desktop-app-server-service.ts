import { getResourceCheckoutService } from "../resource-checkouts/checkout-runtime";
import { navigationPathIdentity } from "@pwragent/shared/directory-navigation";
import type { AgentMemoryRequest, AgentMemoryResult } from "@pwragent/shared/contracts/agent-memory";
import { DesktopDirectoryGitStatus } from "./desktop-directory-git-status";
import { ThreadPullRequestLookup } from "./thread-pull-request-lookup";
import {
  normalizePrLookupDirectoryPaths,
  normalizePullRequestProvider,
  normalizePrSummary,
  mergeLinkedDirectoryPaths,
  stripPrLinkedDirectoryPaths,
  confirmedGithubPrMergeState,
  stabilizeGithubPrMergeState,
  type PrStatusObservations,
  dedupePrsByStatusKey,
  getPrStatusKey,
  prSummariesEqual,
} from "./thread-pull-request-summaries";

import { getOwnerHostServices, rendererSubscribers as subscribersForChannel } from "../owner-host";
import {
  createThreadDependencyStorage,
  createThreadSandboxStorage,
  createThreadSearchStorage,
} from "../storage/desktop-runtime-storage";
import { getDesktopNavigationQueryPool } from "../app-server/navigation-query-pool";
import { ThreadPendingWakesCache } from "../app-server/thread-pending-wakes-cache";
import type { DesktopAutomaticArchiveRetiredNotice } from "@pwragent/shared/thread-archive-policy";
import { assertMergeNotHeld, blockingMergeDependencies, resolveMergePullRequest } from "./thread-dependency-merge-hold";
import {
  appendPeerDependents, collectPeerActiveDependencies, manageRemoteThreadDependencies, readFederationThreadDependenciesRequest,
} from "./thread-dependencies-federation";
import { detachOwnedThreadDirectory } from "../app-server/thread-directory-detach";
import { ForgeReadService, repositoryFromPr } from "../pr-status/forge-read-service";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import { GithubPrToolClient } from "../pr-status/github-pr-tool-client";
import { ForgePrToolService, type ForgePrToolScope } from "../pr-status/forge-pr-tool-service";
import type { ForgePrToolPreflightResult } from "../agent-tools/pwragent-forge-pr-agent-tools";
import { GitlabPrToolClient } from "../pr-status/gitlab-pr-tool-client";
import type { ForgePrToolArgs, ForgePrToolOperation } from "../pr-status/forge-pr-tool-contract";
import { ForgeReadError, type ForgeReadArgs, type ForgeReadOperation, type ForgeRepository } from "../pr-status/forge-tool-contract";
import { readForgeRepositoryRemotes, type GitHubRepoRef } from "../pr-status/git-remote";
import { createInventoryRemoteConfigReader } from "../pr-status/git-remote-inventory";
import { prGitSubprocessCaller } from "../diagnostics/git-subprocess-diagnostics";
import { getDesktopStackReader, StackReadObservation, stackMemberships, type StackReader, type StackThreadActivity } from "../stacks/stack-reader";
import { GithubForgeStackDiscovery, githubForgeStackRepository, type GithubForgeStack } from "../stacks/github-forge-stacks";
import { StackOperationsService } from "../stacks/stack-operations-service";
import { StackOperationError } from "@pwragent/owner-core/stacks/stack-coordinator";
import { assertGithubStackMergeAllowed, githubStackRepository, isObservedStackParent } from "../stacks/stack-merge-guard";
import { createReviewStackWakeScope } from "../stacks/review-stack-wake-scope";
import { readStackPublishHead } from "../stacks/github-stack-publish";
import type { StackLayer, StackSummary } from "@pwragent/shared/stacks/stack-status";
import { describeStackAutomationBlock, nextStackAdvance, stackDispatchBlock } from "@pwragent/shared/stacks/stack-automation";
import { readLocalHeadPastPrHead } from "../pr-status/local-pr-head";
import { PrChangeIdentityReader } from "../pr-status/pr-change-identity";
import { PrReviewOfferCoordinator, type PrReviewOfferThread } from "../pr-status/pr-review-offer-coordinator";
import {
  ineligiblePrReviewOfferThreads,
  selectPrReviewOfferOwner,
  type PrReviewOfferCandidate,
} from "../pr-status/pr-review-offer-owner";
import { describePrReviewReadiness } from "../pr-status/pr-review-readiness";
import { getThreadReviewService } from "../thread-reviews/thread-review-runtime";
import type { ReviewAutoFixStackWakeFilter } from "../thread-reviews/review-auto-fix";
import { reviewContextPullRequests, type ThreadReview } from "@pwragent/shared/contracts/thread-reviews";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { publishedPrCommitShas } from "../../shared/pull-request-publication";
import {
  THREAD_PR_WATCH_HISTORY_MAX_LIMIT,
  type ThreadPrAutoFixState,
  type ThreadPrWatchesRequest,
  type ThreadPrWatchesResponse,
} from "@pwragent/shared/contracts/thread-pr-watches";
import { type WatchThreadPullRequestReason } from "@pwragent/shared/contracts/thread-tools";
import {
  isThreadDependencyLocalThreadCondition,
  threadDependencyDeliveryKey,
  type ManageThreadDependenciesRequest,
  type ManageThreadDependenciesResponse,
  type ThreadDependency,
  type ThreadDependencyCondition,
  type ThreadDependencyMergeBuildObservation,
} from "@pwragent/shared/contracts/thread-dependencies";
import {
  type AppServerThreadTurnMetadata,
  type AppServerNotification,
  type ReadThreadWorktreeLockRequest,
  type ReadThreadWorktreeLockResponse,
  type RemoveLockedThreadWorktreesRequest,
  type RemoveLockedThreadWorktreesResponse,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  type ThreadPendingWakesList,
  type ThreadPendingWakesRequest,
  type ThreadPendingWakesResponse,
} from "@pwragent/shared/contracts/thread-pending-wakes";
import { findRemoteHomeDirectoryIndex } from "@pwragent/shared/federation-project-match";
import {
  buildThreadPendingWakes,
  stopThreadPendingWake,
  type ThreadPendingWakeReaders,
} from "../app-server/thread-pending-wakes";
import { getScheduledThreadActionService } from "../scheduled-actions/scheduled-thread-action-service";
import { evaluateCondition, ThreadDependencyCoordinator, validateDependencyCreate, type DependencyThreadSnapshot } from "../app-server/thread-dependency-coordinator";
import { authorizeLocalFile, LocalFilePoller, readLocalFile } from "./thread-dependency-local-files";
import { CI_RUN_URL_FORMS, ciApprovalSettled, parseCiRunUrl, readCiRun, readGithubRunGates, ThreadDependencyCiRunPoller, type CiRunUrlOptions } from "../app-server/thread-dependency-ci-runs";
import { approveGithubCiDeployment, CiDeploymentReviewRefusal } from "../thread-todos/ci-deployment-review";
import { FORGE_AGENT_TOOL_GROUP_LABELS, resolveForgeAgentToolAccess } from "@pwragent/shared/contracts/forge-agent-tools";
import type { ReviewThreadTodoCiDeploymentRequest } from "@pwragent/shared/contracts/thread-todos";
import type { ThreadDependencyCiRunObservation } from "@pwragent/shared/contracts/thread-dependencies";
import { mergeCommitOf, readMergeBuild } from "../app-server/thread-dependency-merge-builds";
import {
  getProjectForgeAutomationIndex,
  summarizeProjectHeldWakeup,
  type ProjectForgeAutomationResolution,
} from "../app-server/project-forge-automation-index";
import { getThreadTodoService, readProjectMergeMethodPreference, readThreadTodoPlacement, setThreadTodoMergeOfferGate } from "../thread-todos/thread-todo-runtime";
import { archiveCandidateProtectionReason } from "../app-server/thread-archive-sweeper";
import { threadArtifactDirectory } from "../app-server/thread-assets";
import { readFederatedThreadFamilyPricing } from "../app-server/thread-family-pricing";
import { createLocalThreadFamilyPricingReader } from "../app-server/thread-family-pricing-source";
import { conditionalThreadRead } from "../app-server/conditional-thread-read";
import type {
  ReadUsageActivityRequest,
  ReadUsageActivityResponse,
  AnalyzeUsageActivityRequest,
  AnalyzeUsageActivityResponse,
} from "@pwragent/shared/contracts/usage-activity";
import type {
  ReadThreadFamilyPricingRequest,
  ReadThreadFamilyPricingResponse,
} from "@pwragent/shared/thread-family-pricing";
import { summarizeThreadAgentChange } from "@pwragent/shared/navigation-state";
import { type PrActivitySnapshot } from "@pwragent/shared/contracts/pr-activity";
import { isDeepStrictEqual } from "node:util";
import { RemoteNavigationPageBaselines } from "../federation/remote-navigation-page-baselines";
import { readRemoteNavigationPageWithinBudget } from "../federation/federation-navigation-query";
import { OneTimeProfileNotice } from "../notices/one-time-profile-notice";
import { navigationLaunchpadProviderKey, type NavigationLaunchpadDefaults } from "@pwragent/shared/contracts/navigation";
import type { NavigationAttentionViewReleaseRequest } from "@pwragent/shared/contracts/navigation";
import type {
  MarkNavigationDirectorySeenRequest,
  MarkNavigationDirectorySeenResponse,
} from "@pwragent/shared/contracts/navigation";
import { markLocalNavigationDirectorySeen, removeLocalNavigationDirectory } from "../app-server/navigation-directory-actions";
import type {
  RemoveNavigationDirectoryRequest,
  RemoveNavigationDirectoryResponse,
} from "@pwragent/shared/contracts/navigation";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OverlayStoreLike,
  PrAutoDispatchCandidateChange,
  PrStatusCacheEntry,
  DesktopOwnerStorage,
} from "../storage/desktop-overlay-store";
import {
  type AgentEvent,
  type CancelThreadPrAutoDispatchRequest,
  type SendThreadPrAutoDispatchNowRequest,
  type SetEligibleThreadsPrAutoDispatchRequest,
  type SetEligibleThreadsPrAutoDispatchResponse,
  type EnsureDirectoryLaunchpadRequest,
  type EnsureDirectoryLaunchpadResponse,
  type ListModelSettingsRecentsRequest,
  type ListModelSettingsRecentsResponse,
  type ListRecentFileReferencesRequest,
  type ListRecentFileReferencesResponse,
  type RecordModelSettingsRecentRequest,
  type PickDirectoryFromDiskResponse,
  type PickFileFromDiskResponse,
  type PickReferenceFromDiskResponse,
  type RenderComposerPdfPreviewRequest,
  type RenderComposerPdfPreviewResponse,
  type RecordRecentFileReferencesRequest,
  type RegisterDirectoryFromDiskRequest,
  type RegisterDirectoryFromDiskResponse,
  type ContinueThreadEnvironmentStartupRequest,
  type ContinueThreadEnvironmentStartupResponse,
  type ListThreadMigrationSourceThreadsRequest,
  type ListThreadMigrationSourceThreadsResponse,
  type ListThreadMigrationSourcesResponse,
  type RetryThreadMigrationRequest,
  type StartThreadMigrationRequest,
  type StartThreadMigrationResponse,
  type ResetDirectoryLaunchpadRequest,
  type ResetDirectoryLaunchpadResponse,
  type UpdateDirectoryLaunchpadRequest,
  type UpdateDirectoryLaunchpadResponse,
} from "@pwragent/shared/contracts/agent";
import {
  type AppServerBackendKind,
  type AppServerTurnInputItem,
  type AppServerBackendScope,
  type AppServerThreadSummary,
  type ArchiveWorktreeRequest,
  type ArchiveWorktreeResponse,
  type ArchiveThreadRequest,
  type ArchiveThreadResponse,
  type AppServerListSkillsRequest,
  type AppServerListSkillsResponse,
  type AppServerListThreadsRequest,
  type AppServerListThreadsResponse,
  type PersistThreadUsageActivityRequest,
  type PersistThreadUsageActivityResponse,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type HandoffThreadWorkspaceRequest,
  type HandoffThreadWorkspaceResponse,
  type MoveThreadToMainCheckoutRequest,
  type MoveThreadToMainCheckoutResponse,
  type RecreateThreadWorktreeRequest,
  type RecreateThreadWorktreeResponse,
  type RenameThreadRequest,
  type RenameThreadResponse,
  type RestoreWorktreeRequest,
  type RestoreWorktreeResponse,
  type ResolveMissingCodexThreadsRequest,
  type ResolveMissingCodexThreadsResponse,
  type RestoreThreadRequest,
  type RestoreThreadResponse,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  type AttachDirectoryToThreadRequest,
  type AttachDirectoryToThreadResponse,
  type DetachDirectoryFromThreadRequest,
  type DetachDirectoryFromThreadResponse,
  type GetNavigationSnapshotRequest,
  type GetGhStatusRequest,
  type GetGlabStatusRequest,
  type GlabStatus,
  type GhStatus,
  type DetachThreadPullRequestRequest,
  type DetachThreadPullRequestResponse,
  type RefreshDirectoryGitStatusesRequest,
  type RefreshDirectoryGitStatusesResponse,
  type RefreshThreadGitWorkingStateRequest,
  type RefreshThreadGitWorkingStateResponse,
  type RefreshOwnedThreadPullRequestsRequest,
  type RefreshThreadPullRequestsRequest,
  type SetPullRequestPollingFocusRequest,
  type SetTranscriptPullRequestsRequest,
  type TranscriptPullRequestStatuses,
  type RefreshThreadPullRequestsResponse,
  type MarkThreadSeenRequest,
  type MarkThreadSeenResponse,
  type NavigationDirectoryGitStatus,
  type NavigationQueryPage,
  type NavigationQueryRequest,
  type NavigationQueueProjection,
  type NavigationQueueProjectionRequest,
  type NavigationLaunchpadConfigRequest,
  type NavigationLaunchpadConfigResponse,
  type NavigationLaunchpadDraft,
  type NavigationSelectedDetailRequest,
  type NavigationSelectedDetailResponse,
  type NavigationSnapshot,
  type NavigationThreadSummary,
  type PrSummary,
  type AddRemoteThreadPinRequest,
  type AddRemoteThreadPinResponse,
  type FederationJumpSearchProgress,
  type FederationJumpSearchRequest,
  type FederationJumpSearchResponse,
  type RemoveRemoteThreadPinRequest,
  type HasRemoteThreadPinRequest,
  type RemoveRemoteThreadPinResponse,
  type SetRemoteThreadLocalPinRequest,
  type SetRemoteThreadLocalPinResponse,
  type ReorderDirectoryPinsRequest,
  type ReorderDirectoryPinsResponse,
  type ReorderThreadPinsRequest,
  type ReorderThreadPinsResponse,
  type SetSubthreadsCollapsedRequest,
  type SetSubthreadsCollapsedResponse,
  type SetDirectoryPinRequest,
  type SetDirectoryPinResponse,
  type SetDirectoryThreadsCollapsedRequest,
  type SetDirectoryThreadsCollapsedResponse,
  type SetThreadParentRequest,
  type SetThreadParentResponse,
  type SetThreadAgentRequest,
  type SetThreadTokenMiserRequest,
  type SetThreadMonitorJobSuggestionsRequest,
  type SetThreadMonitorJobSuggestionsResponse,
  type SetThreadJobMonitorCreationRequest,
  type SetThreadJobMonitorCreationResponse,
  type SetThreadTokenMiserResponse,
  type SetThreadAgentResponse,
  type SetThreadPinRequest,
  type SetThreadPinResponse,
  type SetThreadReactionRequest,
  type SetThreadReactionResponse,
  type SetThreadLockRequest,
  type SetThreadCheckoutHibernationRequest,
  type SetThreadCheckoutHibernationResponse,
  type SetThreadLockResponse,
  type AcknowledgeThreadEnvironmentFailureRequest,
  type AcknowledgeThreadEnvironmentFailureResponse,
  type ListPendingThreadSpendAlertsRequest,
  type ListPendingThreadSpendAlertsResponse,
  type AcknowledgeThreadSpendAlertRequest,
  type AcknowledgeThreadSpendAlertResponse,
  type SetNavigationBrowseModeRequest,
  type SetNavigationBrowseModeResponse,
  type SetPinnedGroupCollapsedRequest,
  type SetPinnedGroupCollapsedResponse,
  type RecentThreadLockNotesResponse,
  type ThreadLockNoteRequest,
  type ResolveEditCommitStatesRequest,
  type ResolveEditCommitStatesResponse,
  type ListWorktreeOtherChangesRequest,
  type ListWorktreeOtherChangesResponse,
  type GetWorktreeOtherChangeDiffRequest,
  type GetWorktreeOtherChangeDiffResponse,
  type ListWorktreeUnpublishedCommitsRequest,
  type ListWorktreeUnpublishedCommitsResponse,
  type GetWorktreeUnpublishedCommitDiffRequest,
  type GetWorktreeUnpublishedCommitDiffResponse,
  type ReadWorktreeImageRequest,
  type ReadWorktreeImageResponse,
  type ThreadOverlayState,
  type ThreadPrAutoDispatchPending,
  type UpdateSubthreadOrderRequest,
  type UpdateSubthreadOrderResponse,
} from "@pwragent/shared/contracts/navigation";
import {
  type CheckThreadPullRequestStatusToolArgs,
  type WatchThreadPullRequestToolArgs,
  type WatchThreadPullRequestResult,
  type ThreadPullRequestWatchListResult,
  type ThreadPullRequestAutomationStatus,
  type ThreadForgeAutomationGates,
  type ThreadPullRequestReviewReadiness,
  type ThreadPullRequestWatchEvent,
  type ThreadPullRequestWatchSummary,
  type ThreadPullRequestWatchBaseline,
  type PwrAgentThreadInspectionResponse,
  type PwrAgentThreadInspectionContext,
} from "@pwragent/shared/contracts/thread-tools";
import {
  type ThreadSearchRequest,
  type ThreadSearchResponse,
} from "@pwragent/shared/contracts/thread-search";
import {
  type InspectTokenMiserOutputRequest,
  type InspectTokenMiserOutputResponse,
  type AnalyzeThreadToolHistoryRequest,
  type AnalyzeThreadToolHistoryResponse,
  type SetThreadToolIncidentNoticeRequest,
  type SetThreadToolIncidentNoticeResponse,
} from "@pwragent/shared/contracts/tool-output-incidents";
import { type BackendSummary } from "@pwragent/shared/contracts/backend";
import { type AutomationThreadSummary } from "@pwragent/shared/contracts/automations";
import {
  type PrAutoDispatchBudgetConfig,
  type PrAutoDispatchBudgetStatus,
} from "@pwragent/shared/contracts/settings";
import { type FederatedThreadRef, type FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import {
  type SetProjectForgeAutomationRequest,
  type SetProjectForgeAutomationResponse,
  type ListProjectHeldWakeupsRequest,
  type ListProjectHeldWakeupsResponse,
  type ResolveProjectHeldWakeupsRequest,
  type ResolveProjectHeldWakeupsResponse,
  type HandsOffMatch,
  type ProjectForgeAutomation,
  buildHandsOffGuidance,
  buildProjectNeverMergeRefusal,
  describeHandsOffMatch,
  findHandsOffMatch,
  buildProjectPrDependencyNotice,
  buildProjectPrWatchRefusal,
  isDefaultProjectForgeAutomation,
  MAX_HANDS_OFF_RULES,
  normalizeHandsOffRules,
  PROJECT_PAUSED_ERROR_CODE,
  projectAllowsAutoFixKind,
  projectAllowsForgePolling,
  projectAllowsPrOffers,
  projectAllowsPrWatches,
  projectMergeBranches,
  projectMergesPullRequest,
  projectNeverMerges,
  projectWatchesMergeBuilds,
  resolveProjectForgeAutomation,
} from "@pwragent/shared/project-forge-automation";
import { type NavigationResumeState } from "@pwragent/shared/navigation-resume-state";
import {
  DEFAULT_BACKGROUND_PR_POLLING,
  DEFAULT_PR_AUTO_DISPATCH_ALLOWED,
  DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
} from "@pwragent/shared/contracts/settings";
import {
  DEFAULT_PULL_REQUEST_PROVIDER,
  buildThreadIdentityKey,
  isAppServerBackendKind,
  parseThreadIdentityKey,
  pullRequestAttachmentIntent,
} from "@pwragent/shared/contracts/navigation";
import { buildPrependPinRank } from "@pwragent/shared/thread-pins";
import {
  buildFederatedThreadRef,
  federatedThreadIdentityKey,
  isFederationInstanceId,
  isRemoteFederationTarget,
  type FederationTarget,
} from "@pwragent/shared/contracts/federation";
import { expandNavigationRemoteOwner } from "@pwragent/shared/navigation-remote-owner";
import { isThreadPendingWakeInvalidation } from "@pwragent/shared/contracts/thread-pending-wakes";
import { mergeThreadLinkedDirectories } from "@pwragent/shared/navigation-state";
import { rankInboxThreadKeys } from "@pwragent/shared/inbox";
import { resolveNewThreadBackend } from "@pwragent/shared/backend-selection";
import { linkedDirectoryForRegistration, registerDirectoryFromDisk } from "../app-server/directory-registration-service";
import { readWorktreeImage } from "../app-server/worktree-image-reader";
import {
  disposeDesktopBackendRegistry,
  getExistingDesktopBackendRegistry,
  getDesktopBackendRegistry,
} from "../app-server/backend-registry";
import {
  selectStaleWorktreeWorkingStatePaths,
} from "../app-server/thread-working-state-refresh-policy";
import { materializeTranscriptImageUrlsForRenderer } from "../transcript-images";
import { hydrateLaunchpadCodexEnvironmentOptions } from "../app-server/codex-environment-config";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { setLocalDirectoryPin, reorderLocalDirectoryPins, rejectNonUserDirectoryKey } from "./local-directory-pins";
import { markLocalThreadSeen } from "../app-server/mark-local-thread-seen";
import { getAppScheduledThreadActionStore, getAppStateMode } from "../storage/desktop-runtime-storage";
import {
  SandboxerPrCleanupService,
  formatSandboxCleanupLines,
  summarizeSandboxCleanup,
  type SandboxCleanupReport,
} from "../mcp-connections/sandboxer-pr-cleanup";
import { getMcpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import {
  listModelSettingsRecents,
  recordModelSettingsRecent,
} from "../storage/desktop-recents-service";
import {
  listRecentFileReferencePaths,
  recordRecentFileReferencePaths,
} from "../storage/desktop-recents-service";
import {
  PR_AUTO_DISPATCH_BUDGET_CHANGED_EVENT_CHANNEL,
  BUNDLED_GIT_LFS_ADVISORY_EVENT_CHANNEL,
  GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL,
  GITHUB_PR_SAML_ENFORCEMENT_EVENT_CHANNEL,
  NAVIGATION_MENTION_SOURCES_CHANGED_EVENT_CHANNEL,
} from "../../shared/ipc";
import { githubPrAccessTargetKey } from "../../shared/github-pr-access";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import {
  PROJECT_FORGE_AUTOMATION_UNSUPPORTED_MESSAGE,
  type FederationRemoteBackendClient,
} from "../federation/federation-backend-bridge";
import {
  assertProjectHeldWakeupResolutions,
  readProjectForgeDirectoryKey,
} from "../app-server/project-forge-automation-requests";
import { getDesktopNavigationQueryStore } from "../app-server/navigation-query-store";
import { searchNavigationOwners } from "../app-server/navigation-jump-search";
import { appendViewerNavigationPins, archivedRemoteThreadPinMounts, attachRemoteThreadsToLocalDirectories, loadViewerNavigationPins, loadViewerWatchedNavigationRows } from "../app-server/navigation-viewer-pins";
import { awaitStartupProviderCoverage, isSidebarDisplayQuery, loadLocalNavigationQueryIndex, loadSidebarNavigationQueryIndex, navigationPullRequestProjection, navigationQueryShowsStacks } from "../app-server/navigation-query-source";
import { reconcileWindowsDirectoryAliases } from "../app-server/navigation-windows-directory-aliases";
import type { NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import { updateLocalSubthreadOrder } from "../app-server/subthread-order-actions";
import { getDesktopNavigationDetailService } from "../app-server/navigation-detail-service";
import {
  isFederationPeerUnavailableError,
} from "../federation/federation-peer-unavailable-error";
import { renderComposerPdfPreview } from "../pdf/composer-pdf-preview";
import { getMainLogger } from "../log";
import { buildMessagingBindingsByThreadKey } from "../messaging/messaging-bindings-snapshot";
import { getDesktopAutomationService } from "../automations/desktop-automation-service";
import { GitLabPrFetcher } from "../pr-status/gitlab-pr-fetcher";
import { ForgePrFetcher, parseForgePrRefFromUrl as parsePrRefFromUrl, type ForgePrRef } from "../pr-status/forge-pr-fetcher";
import {
  createScheduledPrPrefetchRepoResolver,
  filterStoredDiscoveredPullRequests,
  resolveScheduledPrPrefetchRepos,
  type PrAttachmentDemand,
} from "../pr-status/pr-detection";
import {
  GithubGraphqlPrClient,
  branchRefKey,
} from "../pr-status/github-graphql-client";
import type { BranchRef } from "../pr-status/github-graphql-client";
import { primaryCheckoutKey, readStoredPrimaryThreadRepository, resolvePrimaryThreadRepoKey, resolvePullRequestDirectoryPath } from "../pr-status/primary-thread-repository";
import { PrPollingScheduler } from "../pr-status/pr-polling-scheduler";
import { TranscriptPrSubscriptions } from "../pr-status/transcript-pr-subscriptions";
import { PrThreadIndex } from "../pr-status/pr-thread-index";
import type { PrPollTarget } from "../pr-status/pr-polling-scheduler";
import { PrPollingFocusTracker } from "../pr-status/pr-polling-focus";
import {
  PrAutoDispatchCoordinator,
  getPrAutoDispatchEventKinds,
  isPrAutoDispatchTurnedOn,
  pullRequestMatchesRepositoryKey,
  type ThreadPrAutoDispatchPreferenceChange,
} from "../pr-status/pr-auto-dispatch";
import {
  PrActivityJournal,
  describePrCheck,
  describePrRepairDecision,
  prCheckTone,
  prRepairDecisionTone,
} from "../pr-status/pr-activity";
import { PullRequestRepositoryAliases } from "../pr-status/pr-repository-aliases";
import {
  PR_STATUS_TOKEN_BUCKET_CAPACITY,
  PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE,
  PrStatusTokenBucket,
} from "../pr-status/pr-status-token-bucket";
import {
  buildPullRequestReferenceUrl,
  isSameNumberInAnotherRepository,
  parsePullRequestReferenceUrl,
  type PullRequestReferenceIdentity,
} from "../pr-status/forge-reference";
import { logPrAutoDispatchOutcome } from "../pr-status/pr-auto-dispatch-log";
import { PR_METADATA_PRIORITY, type PrMetadataDemand } from "../pr-status/pr-metadata-process";
import {
  PrStatusWatchCoordinator,
  getPrStatusWatchOutcome,
} from "../pr-status/pr-status-watch";
import { isTerminalPullRequest, mergeCommitShas } from "../pr-status/pr-derivations";
import {
  computePrStatusTransition,
  summarizePrStatusTransition,
} from "../pr-status/pr-transitions";
import type { PrStatusTransition } from "../pr-status/pr-transitions";
import type { ThreadPullRequestMergeResult } from "../pr-status/thread-pull-request-merge";
import { setPullRequestBaseLookup } from "../pr-status/pull-request-base-lookup";
import { selectDiscoveryDueThreadKeys, selectRecentPrDiscoveryThreads } from "../pr-status/pr-discovery";

/** Listener registered via `onPrStatusTransition`. */
type PrStatusTransitionListener = (transition: PrStatusTransition) => void;
import {
  getDesktopConfigStore,
  getDesktopSettingsService,
} from "../settings/desktop-settings-singleton";
import { resolvePrAutomationConfig } from "../settings/config-store/config-domains";
import { resolveScratchProjectsRoots } from "../app-server/scratch-projects";
import { ThreadMigrationService } from "../app-server/thread-migration-service";
import { ProviderTranscriptThreadSearchAdapter, registryTranscriptReader } from "../thread-search/thread-search-provider-adapters";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import { bundledSkillRootAliases } from "../agent-tools/bundled-skill-root";
import {
  shapeReadThreadFileDiffsForRenderer,
} from "../app-server/thread-file-diff-cache";

/** The note in a recent-lock-note request; the renderer's payload is untrusted. */
export { prSummariesEqual } from "./thread-pull-request-summaries";

function readThreadLockNoteRequest(request: ThreadLockNoteRequest | undefined): string {
  return typeof request?.note === "string" ? request.note : "";
}

const navigationQueryPool = getDesktopNavigationQueryPool();
let nextTransientNavigationConsumer = 0;

const isDevelopment = process.env.NODE_ENV !== "production";
const PR_STATUS_WATCH_CURRENT_OUTCOME_MAX_AGE_MS = 30_000;
/**
 * GitHub can take this long to show a queued re-run, so a status read this
 * soon after `rerun_failed_ci_jobs` may still be the attempt it replaced.
 */
const RERUN_SETTLE_MS = 20_000;
/** A recorded re-run older than this no longer explains a cached outcome. */
const RERUN_RECORD_MAX_AGE_MS = 24 * 60 * 60_000;
/** How long a merge/close wake waits for sandbox cleanup to report. */
const SANDBOX_CLEANUP_WAKE_WAIT_MS = 30_000;
/** A merge seen later than this after it happened arms no merge build watch. */
const MERGE_BUILD_ARM_MAX_AGE_MS = 6 * 60 * 60_000;
/** How long a by-URL resolve the forge could not answer waits before asking again. */
const PR_REFERENCE_RETRY_MS = 10 * 60_000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
// PR discovery (Layer B): a slow branch-lookup rotation across ALL open threads
// to catch newly opened PRs on projects the operator is not looking at. Tick
// often, but sweep each thread rarely and only a few per tick, so discovery
// never drains the shared PR token bucket away from the fast status poller.
const PR_DISCOVERY_TICK_INTERVAL_MS = 60_000;
const PR_DISCOVERY_CADENCE_MS = 5 * 60_000;
const PR_DISCOVERY_MAX_PER_TICK = 3;
type AppServerOverlayStoreLike = OverlayStoreLike &
  Pick<
    DesktopOwnerStorage,
    | "readDetachedThreadPullRequests"
    | "readThreadPullRequestUrls"
    | "initializeNavigationUnreadBaseline"
    | "readDirectoryGitStatusCache"
    | "writeDirectoryGitStatusCacheEntry"
    | "readThreadGitWorkingStateCache"
    | "writeThreadGitWorkingStateCacheEntry"
    | "addRemoteThreadPin"
    | "hasRemoteThreadPin"
    | "listPinnedThreadOverlayRanks"
    | "removeRemoteThreadPin"
    | "setRemoteThreadLocalPin"
    | "listRemoteThreadPins"
    | "updateRemoteThreadPinSnapshots"
    | "setThreadToolIncidentNotice"
    | "listPendingThreadSpendAlerts"
    | "acknowledgeThreadSpendAlert"
    | "acknowledgeThreadEnvironmentFailure"
  >;

type ThreadPrAttachment = {
  backend: AppServerBackendKind;
  primaryRepoKey?: string;
  workspace?: Pick<NavigationThreadSummary, "linkedDirectories" | "gitOriginUrl">;
  prs: PrSummary[];
};

type ThreadPrRefreshContext = {
  backend: AppServerBackendKind;
  threadId: string;
  branch: string;
  directoryPaths: string[];
  branchScoped: boolean;
};

const appServerLog = getMainLogger("pwragent:app-server");

/**
 * Forge Automation is owner-local and per Directories project. A remote
 * window's request belongs to the peer that owns the project, which v1 does
 * not reach.
 */
/**
 * The peer that owns the project a Forge Automation request names, or
 * undefined when this instance owns it. A peer that does not advertise
 * `project_forge_automation`, or grants no `turn_control`, is refused here
 * rather than asked.
 */
function remoteProjectForgeOwner(request: {
  federationTarget?: FederationTarget;
}): FederationRemoteBackendClient | undefined {
  const target = request?.federationTarget;
  if (!target || !isRemoteFederationTarget(target)) return undefined;
  const runtime = getDesktopFederationRuntime();
  if (!runtime.remoteTargetSupportsCapability(target, "project_forge_automation")) {
    throw new Error(PROJECT_FORGE_AUTOMATION_UNSUPPORTED_MESSAGE);
  }
  if (!runtime.remoteTargetSupportsCapability(target, "turn_control")) {
    throw new Error("The owning instance does not allow this machine to control its turns.");
  }
  return runtime.remoteBackend(target);
}


/**
 * `preferredBackendFallback` for an ensure response, given the provider the
 * thread's owner resolved its defaults to. Ensure resolves `preferredBackend`
 * to itself whenever the owner can start it, so any other answer is the
 * owner's fallback.
 */
function preferredBackendFallback(
  preferredBackend: AppServerBackendKind | undefined,
  ownerBackend: AppServerBackendKind | undefined,
): Pick<EnsureDirectoryLaunchpadResponse, "preferredBackendFallback"> {
  return preferredBackend && ownerBackend && ownerBackend !== preferredBackend
    ? { preferredBackendFallback: ownerBackend }
    : {};
}

/**
 * The viewer's draft for a thread another instance runs, switched to a
 * provider that instance can start.
 *
 * The viewer stores the draft and resolves its provider against its own
 * providers: its sticky default, the request's `preferredBackend`, or what
 * the draft already held. That can name one the owner lacks, such as this
 * instance's Claude on a peer without a Claude sign-in, and the thread could
 * not start. The owner resolves `preferredBackend` to itself whenever it can
 * start it, so its `defaults.backend` answers the question when the owner was
 * asked about the draft's provider. Otherwise the owner's provider list does,
 * by the rule the owner itself applies, without a second ensure there.
 *
 * A provider the owner can start stays. So does a draft whose settings the
 * operator picked (`settingsTouchedAt`): that choice is theirs to change.
 */
async function resolveRemoteLaunchpadSettings(params: {
  localResponse: EnsureDirectoryLaunchpadResponse;
  ownerResponse: EnsureDirectoryLaunchpadResponse;
  preferredBackend: AppServerBackendKind | undefined;
  listOwnerBackends: () => Promise<BackendSummary[]>;
  /** Seeds the stored draft only while it still holds `from`, untouched. */
  updateDraftSettings: (
    from: AppServerBackendKind,
    patch: Partial<NavigationLaunchpadDraft>,
    ownerProviderSettings: NavigationLaunchpadDefaults["providerSettings"],
  ) => Promise<NavigationLaunchpadDraft>;
}): Promise<EnsureDirectoryLaunchpadResponse> {
  const { localResponse, ownerResponse } = params;
  const draftBackend = localResponse.launchpad.backend;
  if (localResponse.launchpad.settingsTouchedAt !== undefined) {
    return localResponse;
  }
  let ownerBackend: AppServerBackendKind | undefined =
    ownerResponse.defaults.backend;
  if (ownerBackend !== draftBackend && params.preferredBackend !== draftBackend) {
    try {
      // Undefined while the owner can start nothing (discovery still
      // running): keep the draft rather than guess.
      ownerBackend = resolveNewThreadBackend(
        await params.listOwnerBackends(),
        draftBackend,
      )?.kind;
    } catch (error) {
      // The draft is already stored; keep it rather than fail the open.
      appServerLog.warn("remote_launchpad_backend_check_failed", {
        backend: draftBackend,
        error: error instanceof Error ? error.message : String(error),
      });
      return localResponse;
    }
  }
  if (!ownerBackend) {
    return localResponse;
  }
  // The viewer stores the prompt, but automatic model settings belong to the
  // owner. Its independent draft may have edits, so take resolved defaults.
  // Seed every provider from the owner's learned settings so switching
  // providers in a fresh draft uses the owner's catalog and prior choices.
  const ownerProviderSettings = ownerResponse.defaults.providerSettings;
  const defaults = ownerResponse.defaults.backend === ownerBackend
    ? ownerResponse.defaults
    : ownerProviderSettings?.[ownerBackend];
  const codexModelProviderId = ownerResponse.defaults.backend === ownerBackend
    ? ownerResponse.defaults.codexModelProviderId
    : undefined;
  const activeProvider = navigationLaunchpadProviderKey({ backend: ownerBackend, model: defaults?.model, codexModelProviderId });
  const inactive = (settings: NavigationLaunchpadDefaults["providerSettings"]) =>
    Object.fromEntries(Object.entries(settings ?? {}).filter(([provider]) => provider !== activeProvider));
  const providerSettingsChanged = ownerProviderSettings !== undefined
    && !isDeepStrictEqual(inactive(ownerProviderSettings), inactive(localResponse.launchpad.providerSettings));
  const patch: Partial<NavigationLaunchpadDraft> = {
    ...(ownerBackend !== draftBackend ? { backend: ownerBackend } : {}),
    ...(codexModelProviderId !== localResponse.launchpad.codexModelProviderId ? { codexModelProviderId } : {}),
    model: defaults?.model,
    reasoningEffort: defaults?.reasoningEffort,
    serviceTier: defaults?.serviceTier,
    fastMode: defaults?.fastMode,
    acpRuntime: defaults?.acpRuntime,
  };
  if (!providerSettingsChanged && Object.entries(patch).every(([key, value]) =>
    isDeepStrictEqual(localResponse.launchpad[key as keyof NavigationLaunchpadDraft], value))) {
    return localResponse;
  }
  return {
    ...localResponse,
    launchpad: await params.updateDraftSettings(draftBackend, patch, ownerProviderSettings),
  };
}

/**
 * Classify combined reference-picker paths as files or directories via
 * `fs.stat`. Unreadable paths (and exotic kinds like sockets) are
 * skipped — the renderer only knows how to route these two kinds.
 */
function classifyReferencePaths(
  paths: string[],
): { path: string; kind: "file" | "directory" }[] {
  const entries: { path: string; kind: "file" | "directory" }[] = [];
  for (const candidate of paths) {
    try {
      const stats = fs.statSync(candidate);
      if (stats.isDirectory()) {
        entries.push({ path: candidate, kind: "directory" });
      } else if (stats.isFile()) {
        entries.push({ path: candidate, kind: "file" });
      }
    } catch {
      // Skip unreadable paths.
    }
  }
  return entries;
}

const PDF_MAGIC = Buffer.from("%PDF-");
const MAX_PDF_REFERENCE_PATHS = 20;
const MAX_COMPOSER_PDF_PREVIEW_FILE_BYTES = 64 * 1024 * 1024;

export function inspectPdfReferencePaths(paths: string[]): {
  filePaths: string[];
  pdfPaths: string[];
} {
  const filePaths: string[] = [];
  const pdfPaths: string[] = [];
  const candidates = [...new Set(paths.filter((candidate) => candidate.trim()))]
    .slice(0, MAX_PDF_REFERENCE_PATHS);
  for (const candidate of candidates) {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(candidate, "r");
      if (!fs.fstatSync(descriptor).isFile()) {
        continue;
      }
      filePaths.push(candidate);
      const header = Buffer.alloc(PDF_MAGIC.byteLength);
      const bytesRead = fs.readSync(descriptor, header, 0, header.byteLength, 0);
      if (bytesRead === PDF_MAGIC.byteLength && header.equals(PDF_MAGIC)) {
        pdfPaths.push(candidate);
      }
    } catch {
      // The path may have been removed or be an unreadable non-file.
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }
  }
  return { filePaths, pdfPaths };
}

/**
 * Read one explicitly referenced PDF from a stable descriptor. The preview
 * endpoint rechecks the magic bytes itself so a path swapped after Composer's
 * earlier inspection cannot become an arbitrary local-file renderer.
 */
function readComposerPdfPreviewFile(filePath: string): {
  data: Buffer;
  fileIdentity: string;
} {
  const candidate = filePath.trim();
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error("Select a local PDF before opening its preview.");
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(candidate, "r");
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      throw new Error("The selected PDF is no longer a regular file.");
    }
    if (before.size > MAX_COMPOSER_PDF_PREVIEW_FILE_BYTES) {
      throw new Error("This PDF is too large to preview locally.");
    }

    const header = Buffer.alloc(PDF_MAGIC.byteLength);
    const bytesRead = fs.readSync(descriptor, header, 0, header.byteLength, 0);
    if (bytesRead !== PDF_MAGIC.byteLength || !header.equals(PDF_MAGIC)) {
      throw new Error("The selected file is no longer a PDF.");
    }

    // The header read uses an explicit position, leaving the descriptor at
    // offset zero. Reading through that descriptor avoids a path-level
    // time-of-check/time-of-use gap while pdfjs consumes the document.
    const data = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const fileIdentity = composerPdfPreviewFileIdentity(before);
    if (
      data.byteLength !== after.size
      || fileIdentity !== composerPdfPreviewFileIdentity(after)
    ) {
      throw new Error("The selected PDF changed while its preview was loading.");
    }
    return { data, fileIdentity };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("The selected PDF could not be read.", { cause: error });
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function composerPdfPreviewFileIdentity(stats: {
  ctimeMs: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

export async function renderExplicitComposerPdfPreview(
  request: RenderComposerPdfPreviewRequest,
): Promise<RenderComposerPdfPreviewResponse> {
  const file = readComposerPdfPreviewFile(request.path);
  if (request.knownFileIdentity === file.fileIdentity) {
    return { fileIdentity: file.fileIdentity, unchanged: true };
  }

  return {
    ...(await renderComposerPdfPreview({ data: file.data })),
    fileIdentity: file.fileIdentity,
    unchanged: false,
  };
}

/**
 * Service-boundary validation for remote-pin refs. The sqlite key is
 * (instanceId, backend, threadId); a malformed ref from a buggy caller
 * would persist a row that dims forever with no owner to resolve it, so
 * reject anything that is not a well-formed remote target with a known
 * backend before it reaches the store. Returns the validated instance id.
 */
function validateRemoteThreadPinRef(ref: FederatedThreadRef): string {
  if (
    !isRemoteFederationTarget(ref.target)
    || !isFederationInstanceId(ref.target.instanceId)
  ) {
    throw new Error("Remote thread pins require a valid remote federation target.");
  }
  if (!isAppServerBackendKind(ref.backend)) {
    throw new Error("Remote thread pins require a known backend kind.");
  }
  return ref.target.instanceId;
}

function logDebug(event: string, payload: Record<string, unknown>): void {
  if (!isDevelopment) {
    return;
  }

  appServerLog.debug(event, payload);
}

function isFederationMethodNotFoundError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "method_not_found",
  );
}

async function hydrateRetainedThreadOverlayData(
  overlayStore: OverlayStoreLike,
  threads: AppServerThreadSummary[],
): Promise<AppServerThreadSummary[]> {
  if (threads.length === 0) {
    return threads;
  }

  const threadIdsByBackend = new Map<AppServerBackendKind, Set<string>>();
  for (const thread of threads) {
    const threadIds = threadIdsByBackend.get(thread.source) ?? new Set<string>();
    threadIds.add(thread.id);
    threadIdsByBackend.set(thread.source, threadIds);
  }

  const overlayEntries: Array<
    readonly [AppServerBackendKind, Record<string, ThreadOverlayState | undefined>]
  > = await Promise.all(
    [...threadIdsByBackend.entries()].map(
      async ([backend, threadIds]): Promise<
        readonly [
          AppServerBackendKind,
          Record<string, ThreadOverlayState | undefined>,
        ]
      > => [
        backend,
        // Listing metadata only: retention reads no transcript field.
        overlayStore.getThreadListingOverlayStates
          ? await overlayStore.getThreadListingOverlayStates({
              backend,
              threadIds: [...threadIds],
              withPrAutoDispatchPending: true,
            })
          : await overlayStore.getThreadOverlayStates({
              backend,
              threadIds: [...threadIds],
            }),
      ],
    ),
  );
  const overlaysByBackend = new Map(overlayEntries);

  return threads.map((thread) => {
    const overlay = overlaysByBackend.get(thread.source)?.[thread.id];
    if (!overlay) return thread;
    return {
      ...thread,
      ...(overlay.worktreeSnapshots?.length ? { worktreeSnapshots: overlay.worktreeSnapshots } : {}),
      archiveRetentionStartedAt: overlay.archiveRetentionStartedAt,
      archiveRetentionProtectedReason: archiveCandidateProtectionReason({ thread, overlay }),
    };
  });
}

function buildAutomationSummariesByThreadKey():
  | Record<string, AutomationThreadSummary | undefined>
  | undefined {
  try {
    return getDesktopAutomationService().buildThreadSummaries();
  } catch (error) {
    appServerLog.warn("automation store unavailable for navigation snapshot", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function directoryStatusesEqual(
  left: NavigationSnapshot["directories"],
  right: NavigationSnapshot["directories"],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((directory, index) => {
    const candidate = right[index];
    if (!candidate || directory.key !== candidate.key) {
      return false;
    }

    const leftStatus = directory.gitStatus;
    const rightStatus = candidate.gitStatus;
    const leftCodexEnvironmentOptions =
      directory.launchpad?.codexEnvironmentOptions ?? null;
    const rightCodexEnvironmentOptions =
      candidate.launchpad?.codexEnvironmentOptions ?? null;
    return (
      JSON.stringify(leftStatus ?? null) === JSON.stringify(rightStatus ?? null) &&
      JSON.stringify(leftCodexEnvironmentOptions) ===
        JSON.stringify(rightCodexEnvironmentOptions)
    );
  });
}

async function hydrateDirectoryLaunchpads(
  directories: NavigationSnapshot["directories"],
): Promise<NavigationSnapshot["directories"]> {
  return await Promise.all(
    directories.map(async (directory) => {
      if (!directory.launchpad) {
        return directory;
      }

      try {
        return {
          ...directory,
          launchpad: await hydrateLaunchpadCodexEnvironmentOptions(
            directory.launchpad,
          ),
        };
      } catch (error) {
        logDebug("getNavigationSnapshot:launchpad-environments-failed", {
          directoryKey: directory.key,
          error: error instanceof Error ? error.message : String(error),
        });
        return directory;
      }
    }),
  );
}

function getNavigationSnapshotRequestKey(
  request: GetNavigationSnapshotRequest,
): string {
  return JSON.stringify({
    backend: request.backend ?? "all",
    federationTarget: request.federationTarget ?? { scope: "local" },
    filter: request.filter ?? "",
    forceRefresh: request.forceRefresh === true,
  });
}

function getRemoteNavigationSnapshotCacheKey(
  request: GetNavigationSnapshotRequest & {
    federationTarget: { scope: "remote"; instanceId: string };
  },
): string {
  // forceRefresh is a renderer scheduling hint. The remote RPC
  // reads the same owner snapshot either way, so every variant shares one
  // last-known fallback during a disconnect.
  return JSON.stringify({
    backend: request.backend ?? "all",
    federationTarget: request.federationTarget,
    filter: request.filter ?? "",
  });
}

function reconcileRemoteLaunchpadBranch(
  branchName: string | undefined,
  gitStatus: NavigationDirectoryGitStatus | null | undefined,
): string | undefined {
  const branchNames = new Set([
    ...(gitStatus?.branches ?? []),
    ...(gitStatus?.branchDetails ?? []).map((branch) => branch.name),
    ...(gitStatus?.baseBranches ?? []),
    ...(gitStatus?.baseBranchDetails ?? []).map((branch) => branch.name),
  ]);
  if (!branchName) {
    return gitStatus?.currentBranch;
  }
  if (branchNames.size === 0) {
    return gitStatus?.currentBranch ?? branchName;
  }
  if (branchNames.has(branchName)) {
    return branchName;
  }
  return gitStatus?.currentBranch;
}

function normalizePrStatusWatchEvents(
  events: ThreadPullRequestWatchEvent[] | undefined,
): ThreadPullRequestWatchEvent[] | undefined {
  if (events === undefined) return ["success", "failure"];
  const normalized = [...new Set(events)];
  if (
    normalized.length === 0
    || normalized.some((event) => !PR_STATUS_WATCH_EVENTS.has(event))
  ) {
    return undefined;
  }
  return normalized;
}

const PR_STATUS_WATCH_EVENTS: ReadonlySet<string> = new Set([
  "success",
  "failure",
  "merged",
  "closed",
]);

/** One or two plain sentences on what will wake the thread, for the agent. */
function describePrWatchArming(params: {
  prNumber: number;
  headSha: string;
  ciEvents: ThreadPullRequestWatchEvent[];
  watch?: ThreadPullRequestWatchSummary;
  watchExisted: boolean;
  terminalWatch?: ThreadPullRequestWatchSummary;
  terminalWatchExisted: boolean;
  knownOutcome?: ThreadPullRequestWatchEvent;
  knownAgeMs?: number;
  /** The checkout's head, past the cached head the watch was armed at. */
  pushedHeadSha?: string;
  /** Who reads it: an agent learns the tool argument that waits anyway. */
  audience: "agent" | "operator";
}): string {
  const head = params.headSha.slice(0, 7);
  const sentences: string[] = [];
  if (params.watch) {
    const baseline = params.watch.baseline;
    const runAttempt = params.watch.runAttempt ?? baseline?.runAttempt;
    const attempt = runAttempt !== undefined
      ? ` (attempt ${runAttempt})`
      : "";
    sentences.push(
      `${params.watchExisted ? "Already watching" : "Watching"} PR #${params.prNumber} at ${head} for the next ${
        params.watch.notifyOn.join(" or ")
      }${attempt}.`,
    );
    if (baseline) {
      sentences.push(
        `The ${baseline.outcome} observed at ${new Date(baseline.observedAt).toISOString()} ${
          baseline.rerunRequestedAt !== undefined ? "predates the re-run and " : ""
        }will not fire this watch.`,
      );
    }
    if (params.pushedHeadSha) {
      sentences.push(
        `Your checkout is at ${params.pushedHeadSha.slice(0, 7)}, past ${head}, so that result is stale. The watch moves to the pushed head when PwrAgent sees it.`,
      );
    }
  } else if (params.knownOutcome && params.ciEvents.length > 0) {
    const seconds = Math.max(0, Math.round((params.knownAgeMs ?? 0) / 1000));
    sentences.push(
      `No ${params.terminalWatch ? "CI " : ""}watch was created: checks on ${head} already finished with ${params.knownOutcome} ${seconds}s ago.${
        params.audience === "agent"
          ? " If CI was re-run outside PwrAgent, call again with waitForNextResult: true."
          : ""
      }`,
    );
  }
  if (params.terminalWatch) {
    const outcomes = params.terminalWatch.notifyOn.map((event) =>
      event === "merged" ? "merges" : "closes without merge"
    );
    sentences.push(
      `${params.terminalWatchExisted ? "Already watching" : "Watching"} PR #${params.prNumber} until it ${
        outcomes.join(" or ")
      }.`,
    );
  }
  return sentences.join(" ");
}

function describePrWatchBrief(watch: ThreadPullRequestWatchSummary): string {
  return (watch.kind ?? "checks") === "checks"
    ? `CI on PR #${watch.prNumber}`
    : `merge or close of PR #${watch.prNumber}`;
}

function describePrWatchList(watches: readonly ThreadPullRequestWatchSummary[]): string {
  if (watches.length === 0) return "No PR watch is waiting on this thread.";
  return `${watches.length} ${watches.length === 1 ? "watch waits" : "watches wait"} on this thread: ${
    watches.map((watch) => `${describePrWatchBrief(watch)} (watchId ${watch.watchId})`).join(", ")
  }.`;
}

function describePrWatchCancel(
  cancelled: ThreadPullRequestWatchSummary,
  remaining: readonly ThreadPullRequestWatchSummary[],
): string {
  const stopped = (cancelled.kind ?? "checks") === "checks"
    ? `Stopped waiting for CI on PR #${cancelled.prNumber}.`
    : `Stopped watching PR #${cancelled.prNumber} for merge or close.`;
  return remaining.length === 0
    ? `${stopped} Nothing else waits on this thread.`
    : `${stopped} ${describePrWatchList(remaining)}`;
}

function normalizePrWatchUrl(url: string | undefined): string | undefined {
  const normalized = url?.trim().replace(/\/+$/, "").toLowerCase();
  return normalized || undefined;
}

type PrStatusRegistryEntry = {
  pr: PrSummary;
  fetchedAt: number;
  lastScheduledRefreshRequestedAt?: number;
  lastUserRefreshRequestedAt?: number;
};

/** Bounded sample of PR keys carried by the stale-observation debug line. */
const STALE_PR_OBSERVATION_LOG_SAMPLE = 5;

class DesktopAppServerService {
  private readonly pendingWakesCache = new ThreadPendingWakesCache(async (thread, options) =>
    await buildThreadPendingWakes(this.pendingWakeReaders(), thread, {
      ...options,
      onReadError: (source, error) => appServerLog.warn("pending wake source unreadable", {
        source, backend: thread.backend, threadId: thread.threadId,
        error: error instanceof Error ? error.message : String(error),
      }),
    }));
  private prFetcher: ForgePrFetcher | undefined;
  private readonly pendingNavigationSnapshots = new Map<
    string,
    Promise<NavigationSnapshot>
  >();
  private readonly remoteNavigationSnapshotCache = new Map<
    string,
    NavigationSnapshot
  >();
  private readonly pendingEditCommitResolves = new Map<
    string,
    Promise<ResolveEditCommitStatesResponse>
  >();
  private readonly prStatusRegistry = new Map<string, PrStatusRegistryEntry>();
  private readonly prCardMerges = new Map<string, { transition?: PrStatusTransition }>();
  private readonly stackReader = getDesktopStackReader();
  private readonly stackPublishAttempts = new Map<string,
    { signature: string; retryAfter?: number } | { declinedHead: string }
  >();
  private readonly stackPublishActive = new Map<string, AbortController>();
  private readonly stackPublishAwaitingObservation = new Map<string, string>();
  private readonly stackOperations = new StackOperationsService(undefined, async (cwd) =>
    (await this.readScopedStacks([cwd], undefined, new StackReadObservation({ priority: () => PR_METADATA_PRIORITY.selected }))).stacks);

  async resumeInterruptedStackOperations(): Promise<void> {
    const registry = getDesktopBackendRegistry();
    const threads = await registry.listThreads({ callerReason: "stack-recovery" });
    const directories = threads.flatMap((thread) => resolveThreadPullRequestDirectoryPaths(thread));
    for (const error of await this.stackOperations.resumeInterrupted(directories, registry)) {
      appServerLog.warn("Stack operation recovery paused", { error });
    }
  }
  private publishedStacks: readonly StackSummary[] = [];
  /** Reads a GitHub stack's members when the poll shows they may have changed; see the module. */
  private readonly githubForgeStackDiscovery = new GithubForgeStackDiscovery({
    read: async (repository, path) => await this.getForgeCiClient().requestGithub(repository, { path }),
    learned: (stack) => this.publishGithubForgeStackLearned(stack),
  });
  private readonly prActivity = new PrActivityJournal();
  /** Repository renames the forge has answered with. See its class. */
  private readonly prRepositoryAliases = new PullRequestRepositoryAliases();
  readonly threadPullRequestLookup = new ThreadPullRequestLookup({
    getOverlayStore: (...args) => this.getOverlayStore(...args),
    loadPrStatusRegistry: (...args) => this.loadPrStatusRegistry(...args),
    filterStoredDiscoveredPrs: (...args) => this.filterStoredDiscoveredPrs(...args),
    mergePrHistory: (...args) => this.mergePrHistory(...args),
    rememberPrStatuses: (...args) => this.rememberPrStatuses(...args),
    canonicalizePrs: (...args) => this.canonicalizePrs(...args),
    detachedPrKeyCanonicalizer: (...args) => this.detachedPrKeyCanonicalizer(...args),
    publishThreadPullRequestsUpdated: (...args) => this.publishThreadPullRequestsUpdated(...args),
    getPrFetcher: (...args) => this.getPrFetcher(...args),
    storedPrsNeedRename: (...args) => this.storedPrsNeedRename(...args),
    threadForgeAutomation: (...args) => this.threadForgeAutomation(...args),
    nextPrObservationTimestamp: (...args) => this.nextPrObservationTimestamp(...args),
    writePrStatusesToCache: (...args) => this.writePrStatusesToCache(...args),
    publishPullRequestStatusUpdates: (...args) => this.publishPullRequestStatusUpdates(...args),
    learnPullRequestRepository: (...args) => this.learnPullRequestRepository(...args),
    recordPrCheck: (...args) => this.recordPrCheck(...args),
    handlePrAutoDispatchSnapshots: (...args) => this.handlePrAutoDispatchSnapshots(...args),
    takePrPollingToken: (...args) => this.takePrPollingToken(...args),
    prRepositoryAliases: this.prRepositoryAliases,
    prActivity: this.prActivity,
    logDebug,
    isFederationMethodNotFoundError,
  });
  /** Counts learned renames, so stored watch keys move once per rename. */
  private prRepositoryAliasGeneration = 0;
  private prWatchKeysGeneration = 0;
  private prWatchKeySync: Promise<void> = Promise.resolve();
  /** One terminal-watch retry covers every rename learned in the same tick. */
  private prRenameRetryQueued = false;
  /**
   * By-URL resolves asked for stored references, by URL. An answer is kept
   * for the session; a failure is asked again after `PR_REFERENCE_RETRY_MS`.
   */
  private readonly prReferenceResolutions = new Map<string, {
    askedAt: number;
    result: Promise<string | undefined>;
    answered: boolean;
  }>();
  private readonly prStatusTokenBucket = new PrStatusTokenBucket();
  private lastPrObservationTimestamp = 0;
  private prStatusRegistryLoaded = false;
  private prStatusRegistryLoadPromise: Promise<void> | undefined;
  private prGraphqlClient: GithubGraphqlPrClient | undefined;
  private readonly githubSamlBlockedRepositories = new Set<string>();
  private readonly githubPrAuthenticationNotice = new OneTimeProfileNotice(
    OneTimeProfileNotice.markerFor("github-pr-authentication-failure"),
    (error) => appServerLog.warn("Could not persist GitHub PR authentication notice", { error }),
  );
  private readonly bundledGitLfsNotice = new OneTimeProfileNotice(
    OneTimeProfileNotice.markerFor("bundled-git-lfs"),
    (error) => appServerLog.warn("Could not persist bundled Git LFS advisory", { error }),
  );
  private prPollingScheduler: PrPollingScheduler | undefined;
  private readonly transcriptPrSubscriptions = new TranscriptPrSubscriptions((key) => {
    if (!this.primaryPrThreadsByKey.has(key)) this.prPollingScheduler?.forgetTarget(key);
  });
  private backgroundPrPollingEnabled = false;
  private prAutoDispatchAllowed = false;
  private prAutoDispatchBudgetConfig: PrAutoDispatchBudgetConfig = {
    capacity: DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
    refillPerMinute: DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
    pauseWhenEmpty: DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
  };
  private prAutoDispatchBudgetPaused = false;
  private prAutoDispatchBudgetPausedAt: number | undefined;
  private prAutoDispatchCoordinator: PrAutoDispatchCoordinator | undefined;
  private prReviewOfferCoordinator: PrReviewOfferCoordinator | undefined;
  private prReviewOfferUnsubscribe: (() => void) | undefined;
  private prStatusWatchCoordinator: PrStatusWatchCoordinator | undefined;
  /**
   * CI re-runs this instance requested, by PR. In memory only: they explain
   * why a cached result at the same head is not the next one.
   */
  private readonly ciRerunsByPrKey = new Map<string, {
    headSha?: string;
    runId: number;
    runAttempt?: number;
    requestedAt: number;
  }>();
  private threadDependencyCoordinator: ThreadDependencyCoordinator | undefined;
  /** Checks CI runs that Continue After waits on; armed only while one waits. */
  private localFilePoller: LocalFilePoller | undefined;
  private resourceCheckoutPoller: LocalFilePoller | undefined;
  private unsubscribeResourceCheckouts?: () => void;
  private threadDependencyCiRunPoller: ThreadDependencyCiRunPoller | undefined;
  private threadDependencyMergeBuildPoller: ThreadDependencyCiRunPoller<ThreadDependencyMergeBuildObservation> | undefined;
  /** Open CI approval cards' runs, read until GitHub no longer holds their gates. */
  private ciApprovalPoller: ThreadDependencyCiRunPoller | undefined;
  /** The latest check of each run an approval card waits on. Memory only. */
  private readonly ciApprovalRuns = new Map<string, ThreadDependencyCiRunObservation>();
  private sandboxerPrCleanup: SandboxerPrCleanupService | undefined;
  private ownerNavigationActive = false;
  private unsubscribeRestartGate?: () => void;
  private ownerNavigationMetadataVersion = 0;
  private ownerNavigationMetadataRead: Promise<void> | undefined;
  private ownerNavigationMetadataAbort: AbortController | undefined;
  private readonly primaryPrThreadsByKey = new PrThreadIndex();
  /** Owner thread→PR attachments plus the primary workspace's repository. */
  private readonly attachedPrsByThreadKey = new Map<string, ThreadPrAttachment>();
  /**
   * This enrichment follows overlay snapshot hashing, so retain the last value
   * sent to the renderer and invalidate when repository resolution changes.
   */
  private readonly publishedPrimaryGitRepositoriesByThreadKey = new Map<
    string,
    string | undefined
  >();
  private readonly prDiscoveryAccessByThreadKey = new Map<string, number>();
  private prDiscoveryTimer: NodeJS.Timeout | undefined;
  /** Per-thread last discovery branch-lookup time, driving the slow rotation. */
  private readonly prDiscoveryLastRefreshedAt = new Map<string, number>();
  /** Set once we subscribe to settings writes for live flag re-sync. */
  private prPollingSettingsUnsubscribe: (() => void) | undefined;
  /** Monotonically increases so an older settings read cannot overwrite a newer one. */
  private prPollingSettingsSyncGeneration = 0;
  /**
   * Threads the operator currently has selected / on screen, pushed from the
   * renderer per window. Drives the poller's fast tier — main cannot infer
   * selection.
   */
  private readonly prPollingFocus = new PrPollingFocusTracker();
  /** prKey → backend to publish its status updates on. Rebuilt per poll pass. */
  private readonly prPollBackendByKey = new Map<string, AppServerBackendKind>();
  /** Subscribers to typed PR status transitions. */
  private readonly prStatusTransitionListeners = new Set<PrStatusTransitionListener>();
  private readonly previousDirectoriesByBackend = new Map<
    AppServerBackendScope,
    NavigationSnapshot["directories"]
  >();
  // Seeded with the empty-list hash so a pinless boot never flips
  // `unchanged` on the first snapshot.
  private lastRemoteThreadPinsMergeHash = "[]";
  private readonly lastDirectoriesByKey = new Map<
    string,
    NavigationSnapshot["directories"][number]
  >();
  private readonly directoryGitStatus = new DesktopDirectoryGitStatus({
    getNavigationQueryPage: (request, consumerId) => this.getNavigationQueryPage(request, consumerId),
    releaseNavigationPage: (consumerId) => navigationQueryPool.release(consumerId),
    findDirectory: (key) => this.lastDirectoriesByKey.get(key),
    getOverlayStore: () => this.getOverlayStore(),
    readDirectoryStatusEntries: (...args) => getDesktopBackendRegistry().readDirectoryStatusEntries(...args),
    publishLocalEvent: (event) => getDesktopBackendRegistry().publishLocalEvent(event),
    logDebug,
  });
  // Maps a thread identity (`backend:threadId`) to its working directory so
  // a turn/command-completion event can refresh the right worktree's chips
  // without re-reading the navigation snapshot. Populated on every snapshot.
  private readonly worktreePathByThreadKey = new Map<string, string>();
  private readonly prRefreshContextByThreadKey = new Map<
    string,
    ThreadPrRefreshContext[]
  >();
  // Provider-observed PR commits are published even with stale local remote
  // refs or a deleted source branch. Keep PR identities to read fresh status.
  private readonly publishedPrCommitsByThread = new Map<
    string,
    { worktreePath: string; prs: PrSummary[] }
  >();
  private threadSearchService: ThreadSearchService | null = null;
  private threadMigrationService: ThreadMigrationService | null = null;
  // Parent of the most recently picked directory, used as the "Add directory"
  // dialog's defaultPath so it reopens where you last browsed instead of the
  // OS default (Documents on a fresh Windows profile). Falls back to the home
  // folder. In-memory: resets to home on app restart.
  private lastPickedDirectoryParent: string | undefined;

  private getThreadMigrationService(): ThreadMigrationService {
    if (!this.threadMigrationService) {
      this.threadMigrationService = new ThreadMigrationService({
        destination: getDesktopBackendRegistry(),
      });
    }
    return this.threadMigrationService;
  }

  private getThreadSearchService(): ThreadSearchService {
    if (!this.threadSearchService) {
      this.threadSearchService = new ThreadSearchService(
        createThreadSearchStorage(),
        async ({ backend, archived }) => {
          const threads = await getDesktopBackendRegistry().listThreads({
            backend,
            archived,
            callerReason: "thread-search",
            enrichDirectories: true,
          });
          return await hydrateRetainedThreadOverlayData(this.getOverlayStore(), threads);
        },
        new ProviderTranscriptThreadSearchAdapter(
          registryTranscriptReader(async (request) => await getDesktopBackendRegistry().readThread(request)),
        ),
      );
    }
    return this.threadSearchService;
  }

  async listThreads(
    request: AppServerListThreadsRequest = {}
  ): Promise<AppServerListThreadsResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      return await getDesktopFederationRuntime()
        .remoteBackend(request.federationTarget)
        .listThreads({
          backend: request.backend,
          archived: request.archived,
          filter: request.filter,
        });
    }
    const backend = request.backend;
    const threads = await getDesktopBackendRegistry().listThreads({
      backend,
      archived: request.archived,
      callerReason: "ipc-list-threads",
      forceRefresh: request.archived === true,
      filter: request.filter,
    });
    if (request.archived) {
      await getDesktopBackendRegistry().observeArchivedThreads(
        threads.map((thread) => ({ backend: thread.source, threadId: thread.id })), Date.now(),
      );
    }
    const hydratedThreads = await hydrateRetainedThreadOverlayData(
      this.getOverlayStore(),
      threads,
    );

    logDebug("listThreads", {
      backend: backend ?? "all",
      count: hydratedThreads.length,
      threadIds: hydratedThreads.slice(0, 5).map((thread) => thread.id),
    });

    return {
      backend: backend ?? "all",
      fetchedAt: Date.now(),
      threads: hydratedThreads,
      workspaceRoots: resolveScratchProjectsRoots(),
    };
  }

  async searchThreads(
    request: ThreadSearchRequest = {},
    onProgress?: (response: ThreadSearchResponse) => void,
    signal?: AbortSignal,
  ): Promise<ThreadSearchResponse> {
    return await getDesktopFederationRuntime().searchThreadContent(
      request,
      async (localRequest, localSignal) => await this.getThreadSearchService().search(localRequest, localSignal),
      onProgress,
      signal,
    );
  }

  async listSkills(
    request: AppServerListSkillsRequest = {},
  ): Promise<AppServerListSkillsResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      // A peer's skill paths are on the peer's machine, so this machine's
      // bundled skill root must never classify them, whatever the peer sent.
      const { bundledSkillRoots: _peerRoots, ...remote } = await getDesktopFederationRuntime()
        .remoteBackend(request.federationTarget)
        .listSkills({
          backend: request.backend,
          catalog: request.catalog,
          cwd: request.cwd,
          cwds: request.cwds,
          threadId: request.threadId,
        });
      return remote;
    }
    const backend = request.backend ?? "codex";
    const response = await getDesktopBackendRegistry().listSkills({
      backend,
      catalog: request.catalog,
      cwd: request.cwd,
      cwds: request.cwds,
      threadId: request.threadId,
    });

    logDebug("listSkills", {
      backend,
      cwd: request.cwd ?? null,
      cwds: request.cwds ?? [],
      entries: response.data.length,
      commands: response.data.reduce(
        (count, entry) => count + (entry.commands?.length ?? 0),
        0,
      ),
      skills: response.data.reduce((count, entry) => count + entry.skills.length, 0),
    });

    return {
      backend,
      fetchedAt: Date.now(),
      data: response.data,
      bundledSkillRoots: bundledSkillRootAliases(),
    };
  }

  async readThread(
    request: AppServerReadThreadRequest
  ): Promise<AppServerReadThreadResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      return await getDesktopFederationRuntime()
        .remoteBackend(request.federationTarget)
        .readThread({
          backend: request.backend,
          display: request.display,
          ...(request.countsAsActivity !== undefined ? { countsAsActivity: request.countsAsActivity } : {}),
          threadId: request.threadId,
          before: request.before,
          includeAllToolInvocations: request.includeAllToolInvocations,
          includeTurns: request.includeTurns,
          limit: request.limit,
          viewOnly: request.viewOnly,
          knownRevision: request.knownRevision,
          readReason: request.readReason,
        });
    }
    const backend = request.backend ?? "codex";
    const registry = getDesktopBackendRegistry();
    const response = await registry.readThread({
      backend,
      display: request.display,
      ...(request.countsAsActivity !== undefined ? { countsAsActivity: request.countsAsActivity } : {}),
      threadId: request.threadId,
      includeAllToolInvocations: request.includeAllToolInvocations,
      includeTurns: request.includeTurns,
      before: request.before,
      limit: request.limit,
      viewOnly: request.viewOnly,
    });

    logDebug("readThread", {
      backend,
      displayResource: request.display?.resource,
      threadId: request.threadId,
      messageCount: response.replay.messages.length,
      hasLastUserMessage: Boolean(response.replay.lastUserMessage),
      hasLastAssistantMessage: Boolean(response.replay.lastAssistantMessage),
      hasPreviousPage: response.replay.pagination.hasPreviousPage,
      threadStatus: response.threadStatus ?? response.replay.threadStatus,
    });

    const hydrated = await getDesktopFederationRuntime()
      .hydrateThreadMessageOrigins(response);
    const materialized = await materializeTranscriptImageUrlsForRenderer(
      hydrated,
      {},
      {
        includeTemporaryImageRoots: true,
        resolveApprovedLocalImageRoots: async () =>
          await registry.getThreadTranscriptImageRoots({
            backend,
            threadId: request.threadId,
          }),
      },
    );
    // Transcript bodies are lossless. Character cuts can split Markdown tables,
    // code fences, and cross-thread message arguments in the middle.
    // A viewer holding this exact page keeps it, as federation owners allow.
    return conditionalThreadRead(
      shapeReadThreadFileDiffsForRenderer(materialized),
      request.knownRevision,
    );
  }

  async readUsageActivity(request: ReadUsageActivityRequest): Promise<ReadUsageActivityResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime().remoteBackend(federationTarget).readUsageActivity(remoteRequest);
    }
    return await getDesktopBackendRegistry().readUsageActivity(request);
  }

  /**
   * A family can span machines: each owner keeps its own threads' totals, so
   * this machine asks each one for its part, wherever the root lives.
   */
  async readThreadFamilyPricing(request: ReadThreadFamilyPricingRequest): Promise<ReadThreadFamilyPricingResponse> {
    const federation = getDesktopFederationRuntime();
    // Without health, pins still resolve by their recorded owner; only the
    // alias for this machine's own id is lost.
    const health = await Promise.resolve().then(() => federation.health()).catch(() => undefined);
    const localInstanceId = health?.instanceId;
    const owner = request.federationTarget && isRemoteFederationTarget(request.federationTarget)
      ? request.federationTarget.instanceId : undefined;
    return await readFederatedThreadFamilyPricing({
      root: { backend: request.backend, threadId: request.threadId, ...(owner ? { ownerInstanceId: owner } : {}) },
      readLocal: createLocalThreadFamilyPricingReader(localInstanceId),
      readRemote: (instanceId, root, deadlineAt) => federation.remoteBackend({ scope: "remote", instanceId })
        .readThreadFamilyPricing(root, { deadlineAt }),
      localInstanceId,
      peerLabel: (instanceId) => health?.peers?.find((peer) => peer.id === instanceId)?.label,
    });
  }

  async analyzeUsageActivity(request: AnalyzeUsageActivityRequest): Promise<AnalyzeUsageActivityResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime().remoteBackend(federationTarget).analyzeUsageActivity(remoteRequest);
    }
    return await getDesktopBackendRegistry().analyzeUsageActivity(request);
  }

  async inspectTokenMiserOutput(
    request: InspectTokenMiserOutputRequest,
  ): Promise<InspectTokenMiserOutputResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime().remoteBackend(federationTarget)
        .inspectTokenMiserOutput(remoteRequest);
    }
    return await getDesktopBackendRegistry().inspectTokenMiserOutput(request);
  }

  async analyzeThreadToolHistory(
    request: AnalyzeThreadToolHistoryRequest,
  ): Promise<AnalyzeThreadToolHistoryResponse> {
    /* The scan pages the thread's transcript, which only the owning instance
       can serve. A viewer analyzing a peer's thread runs it over there. */
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .analyzeThreadToolHistory(remoteRequest);
    }
    return await getDesktopBackendRegistry().analyzeThreadToolHistory(request);
  }

  async persistThreadUsageActivity(
    request: PersistThreadUsageActivityRequest,
  ): Promise<PersistThreadUsageActivityResponse> {
    const response = await this.getOverlayStore().persistThreadUsageActivity({
      backend: request.backend,
      threadId: request.threadId,
      activity: request.activity,
    });
    return {
      backend: request.backend,
      threadId: request.threadId,
      activityId: request.activity.id,
      persisted: response.persisted,
    };
  }

  async archiveThread(
    request: ArchiveThreadRequest,
  ): Promise<ArchiveThreadResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .archiveThread(remoteRequest);
    }
    const backend = request.backend ?? "codex";
    await getDesktopFederationRuntime().ungroupRemoteChildrenOfArchivedThread({
      backend, parentThreadId: request.threadId, expectedParent: request.expectedParent,
    });
    const response = await getDesktopBackendRegistry().archiveThread({ ...request, backend });

    logDebug("archiveThread", {
      backend,
      threadId: request.threadId,
      cleanupCount: response.cleanup.length,
    });

    return response;
  }

  async resolveMissingCodexThreads(
    request: ResolveMissingCodexThreadsRequest,
  ): Promise<ResolveMissingCodexThreadsResponse> {
    const response = await getDesktopBackendRegistry()
      .resolveMissingCodexThreads(request);
    for (const threadId of response.archivedThreadIds) {
      // The archives are already committed. One unreachable peer must not
      // skip the ungrouping the remaining threads still need, nor reject a
      // call whose result the caller uses to report what happened.
      try {
        await getDesktopFederationRuntime().ungroupRemoteChildrenOfArchivedThread({
          backend: "codex",
          parentThreadId: threadId,
        });
      } catch (error) {
        logDebug("resolveMissingCodexThreads remote ungroup failed", {
          error: error instanceof Error ? error.message : String(error),
          threadId,
        });
      }
    }
    logDebug("resolveMissingCodexThreads", {
      action: response.action,
      archivedCount: response.archivedThreadIds.length,
      failedCount: response.failedThreadIds.length,
    });
    return response;
  }

  async restoreThread(
    request: RestoreThreadRequest,
  ): Promise<RestoreThreadResponse> {
    const backend = request.backend ?? "codex";
    const response = await getDesktopBackendRegistry().restoreThread({
      ...request,
      backend,
    });

    logDebug("restoreThread", {
      backend,
      threadId: request.threadId,
    });

    return response;
  }

  async listThreadMigrationSources(): Promise<ListThreadMigrationSourcesResponse> {
    return await this.getThreadMigrationService().listSources();
  }

  async listThreadMigrationSourceThreads(
    request: ListThreadMigrationSourceThreadsRequest,
  ): Promise<ListThreadMigrationSourceThreadsResponse> {
    return await this.getThreadMigrationService().listSourceThreads(request);
  }

  async startThreadMigration(
    request: StartThreadMigrationRequest,
  ): Promise<StartThreadMigrationResponse> {
    return await this.getThreadMigrationService().startMigration(request);
  }

  async retryThreadMigration(
    request: RetryThreadMigrationRequest,
  ): Promise<StartThreadMigrationResponse> {
    return await this.getThreadMigrationService().retryMigration(request);
  }

  async archiveWorktree(
    request: ArchiveWorktreeRequest,
  ): Promise<ArchiveWorktreeResponse> {
    const response = await getDesktopBackendRegistry().archiveWorktree(request);

    logDebug("archiveWorktree", {
      backend: request.backend,
      threadId: request.threadId,
      worktreePath: request.worktreePath,
      snapshotRef: response.snapshot.snapshotRef,
    });

    return response;
  }

  async restoreWorktree(
    request: RestoreWorktreeRequest,
  ): Promise<RestoreWorktreeResponse> {
    const response = await getDesktopBackendRegistry().restoreWorktree(request);

    logDebug("restoreWorktree", {
      backend: request.backend,
      threadId: request.threadId,
      worktreePath: request.worktreePath,
      snapshotRef: response.snapshot.snapshotRef,
    });

    return response;
  }

  async handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget: _federationTarget, ...remoteRequest } = request;
      const response = await getDesktopFederationRuntime()
        .remoteBackend(request.federationTarget)
        .handoffThreadWorkspace(remoteRequest);
      logDebug("handoffThreadWorkspace", {
        backend: request.backend,
        threadId: request.threadId,
        direction: request.direction,
        workMode: response.workMode,
        targetPath: response.targetPath,
        federationTarget: request.federationTarget.instanceId,
      });
      return response;
    }
    const response = await getDesktopBackendRegistry().handoffThreadWorkspace(request);

    logDebug("handoffThreadWorkspace", {
      backend: request.backend,
      threadId: request.threadId,
      direction: request.direction,
      workMode: response.workMode,
      targetPath: response.targetPath,
    });

    return response;
  }

  async recreateThreadWorktree(
    request: RecreateThreadWorktreeRequest,
  ): Promise<RecreateThreadWorktreeResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .recreateThreadWorktree(remoteRequest);
    }
    const { federationTarget: _federationTarget, ...localRequest } = request;
    return await getDesktopBackendRegistry().recreateThreadWorktree(localRequest);
  }

  async moveThreadToMainCheckout(
    request: MoveThreadToMainCheckoutRequest,
  ): Promise<MoveThreadToMainCheckoutResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .moveThreadToMainCheckout(remoteRequest);
    }
    const { federationTarget: _federationTarget, ...localRequest } = request;
    return await getDesktopBackendRegistry().moveThreadToMainCheckout(localRequest);
  }

  /** On the thread's owner. An owner too old to read locks reports none, so
   * the handoff keeps a locked worktree, as before. */
  async readThreadWorktreeLock(
    request: ReadThreadWorktreeLockRequest,
  ): Promise<ReadThreadWorktreeLockResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .readThreadWorktreeLock(remoteRequest);
    }
    const { federationTarget: _federationTarget, ...localRequest } = request;
    return await getDesktopBackendRegistry().readThreadWorktreeLock(localRequest);
  }

  /** On the owner of every listed worktree; the caller groups by owner. */
  async removeLockedThreadWorktrees(
    request: RemoveLockedThreadWorktreesRequest,
  ): Promise<RemoveLockedThreadWorktreesResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .removeLockedThreadWorktrees(remoteRequest);
    }
    const { federationTarget: _federationTarget, ...localRequest } = request;
    return await getDesktopBackendRegistry().removeLockedThreadWorktrees(localRequest);
  }

  async renameThread(
    request: RenameThreadRequest,
  ): Promise<RenameThreadResponse> {
    const backend = request.backend ?? "codex";
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget: _federationTarget, ...remoteRequest } = request;
      const response = await getDesktopFederationRuntime()
        .remoteBackend(request.federationTarget)
        .renameThread({
          ...remoteRequest,
          backend,
        });
      logDebug("renameThread", {
        backend,
        threadId: request.threadId,
        federationTarget: request.federationTarget.instanceId,
      });
      return response;
    }
    const response = await getDesktopBackendRegistry().renameThread({
      ...request,
      backend,
    });

    logDebug("renameThread", {
      backend,
      threadId: request.threadId,
    });

    return response;
  }

  async getNavigationSnapshot(
    request: GetNavigationSnapshotRequest = {},
  ): Promise<NavigationSnapshot> {
    const requestKey = request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
      ? getRemoteNavigationSnapshotCacheKey({
          ...request,
          federationTarget: request.federationTarget,
        })
      : getNavigationSnapshotRequestKey(request);
    const pending = this.pendingNavigationSnapshots.get(requestKey);
    if (pending) {
      return await pending;
    }

    const promise = this.readNavigationSnapshot(request).finally(() => {
      if (this.pendingNavigationSnapshots.get(requestKey) === promise) {
        this.pendingNavigationSnapshots.delete(requestKey);
      }
    });
    this.pendingNavigationSnapshots.set(requestKey, promise);

    return await promise;
  }

  /** A page for callers in this process: another owner's rows arrive filled in. */
  async getNavigationQueryPage(
    request: NavigationQueryRequest,
    consumerId?: string,
  ): Promise<NavigationQueryPage> {
    return expandNavigationRemoteOwner(await this.getNavigationQueryWirePage(request, consumerId));
  }

  /**
   * A page as it is retained and sent to a window. Another owner's rows stay
   * as the owner selected them, with this viewer's facts once in
   * `remoteOwner`; the window fills its rows in from that.
   */
  async getNavigationQueryWirePage(
    request: NavigationQueryRequest,
    consumerId?: string,
  ): Promise<NavigationQueryPage> {
    if (consumerId) {
      return navigationQueryPool.read({
        consumerId,
        request,
        load: async ({ signal, deadlineAt }) => {
          signal.throwIfAborted();
          return this.readNavigationQueryPage(request, { signal, deadlineAt });
        },
      });
    }
    return this.readNavigationQueryPage(request);
  }

  private readonly remoteNavigationPageBaselines = new RemoteNavigationPageBaselines();

  private async readNavigationQueryPage(
    request: NavigationQueryRequest,
    rpcOptions?: { deadlineAt: number; signal: AbortSignal },
  ): Promise<NavigationQueryPage> {
    if (!request.federationTarget || !isRemoteFederationTarget(request.federationTarget)) {
      return this.readNavigationQueryPageOnce(request, rpcOptions);
    }
    // The viewer's additions ride in `remoteOwner` and do not count against
    // the budget, so the owner's first page fits. See the helper for the rest.
    return readRemoteNavigationPageWithinBudget({
      request,
      read: (sized) => this.readNavigationQueryPageOnce(sized, rpcOptions),
    });
  }

  private async readNavigationQueryPageOnce(
    request: NavigationQueryRequest,
    rpcOptions?: { deadlineAt: number; signal: AbortSignal },
  ): Promise<NavigationQueryPage> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      // Owner resolution reads this machine's peers for its own viewer. It must
      // never become a request this instance sends to an owner.
      if (request.query.kind === "exact" && request.query.resolveFromOwners) {
        throw new Error("Owner-resolved navigation is available only to this machine's viewer inventory.");
      }
      const target = request.federationTarget;
      const runtime = getDesktopFederationRuntime();
      const ownerPage = await this.remoteNavigationPageBaselines.read(request, async (ownerRequest) => {
        const result = await runtime.remoteNavigationOwnerQueryPage(target, ownerRequest, rpcOptions);
        rpcOptions?.signal.throwIfAborted();
        return result;
      }, request.consumer === "main-sidebar" && runtime.remoteTargetSupportsCapability(target, "navigation_page_deltas_v1"));
      rpcOptions?.signal.throwIfAborted();
      // The owner's rows are returned untouched. Everything this viewer adds
      // goes in one block, so the page costs here what it cost its owner.
      const page: NavigationQueryPage = { ...ownerPage, remoteOwner: runtime.remoteNavigationOwner(target) };
      if (request.query.kind === "exact" && request.consumer === "main-sidebar" && !page.unchanged && !page.rangeUnchanged) {
        const instanceId = request.federationTarget.instanceId;
        const snapshots = expandNavigationRemoteOwner(page).entries.flatMap(({ row }) => {
          const federation = row.federation;
          if (federation?.ref.target.scope !== "remote" || federation.ref.target.instanceId !== instanceId) return [];
          return [{ ref: federation.ref, summary: row, instanceLabel: federation.instanceLabel }];
        });
        const hydrated = await this.getOverlayStore().updateRemoteThreadPinSnapshots(snapshots, { onlyMissing: true });
        if (hydrated) {
          appServerLog.info("hydrated summaryless remote thread pins from exact owner rows", { instanceId,
            candidates: snapshots.slice(0, 10).map(({ ref, summary }) => ({ backend: ref.backend,
              threadId: ref.threadId.slice(0, 200), parentThreadId: summary.parentThreadId?.slice(0, 200),
              parentInstanceId: summary.parentThreadInstanceId?.slice(0, 200), directoryCount: summary.linkedDirectories.length })) });
          await getDesktopBackendRegistry().publishLocalEvent({
            backend: snapshots[0]!.ref.backend,
            notification: { method: "navigation/remoteThreadPins/changed", params: { instanceId } },
          });
        }
      }
      const directoryKeys = [...new Set([...(page.directories ?? []).map((directory) => directory.key),
        ...(page.selectionDirectory ? [page.selectionDirectory.key] : [])])];
      if (!directoryKeys.length) return page;
      const overlays = await this.getOverlayStore().readRemoteDirectoryOverlays({
        instanceId: request.federationTarget.instanceId, directoryKeys,
      });
      rpcOptions?.signal.throwIfAborted();
      // The owner's Forge Automation rides on its rows as stored there; only
      // the disclosure is this viewer's own.
      const directoryThreadsCollapsed: Record<string, boolean> = {};
      for (const directory of [...(page.directories ?? []), ...(page.selectionDirectory ? [page.selectionDirectory] : [])]) {
        const collapsed = overlays[directory.key]?.directoryThreadsCollapsed;
        if (collapsed !== undefined && collapsed !== directory.directoryThreadsCollapsed) {
          directoryThreadsCollapsed[directory.key] = collapsed;
        }
      }
      return Object.keys(directoryThreadsCollapsed).length
        ? { ...page, remoteOwner: { ...page.remoteOwner!, directoryThreadsCollapsed } } : page;
    }
    const sidebar = isSidebarDisplayQuery(request);
    return await getDesktopNavigationQueryStore().readPage({
      incremental: sidebar,
      pullRequests: navigationPullRequestProjection({ kind: request.query.kind, signal: rpcOptions?.signal, backgroundValidation: sidebar, backend: request.backend }),
      loadIndex: async () => {
        rpcOptions?.signal.throwIfAborted();
        await awaitStartupProviderCoverage({ query: request.query, readReason: request.readReason,
          deadlineAt: rpcOptions?.deadlineAt ?? request.deadlineAt, signal: rpcOptions?.signal });
        const summaries = request.inventory === "viewer"
          ? getDesktopFederationRuntime().remoteThreadSummaries() : undefined;
        const prepare = async () => {
          const pins = await loadViewerNavigationPins(getDesktopOverlayStore(), summaries!);
          const localInstanceId = pins.length ? (await getDesktopFederationRuntime().health()).instanceId : undefined;
          return (local: NavigationQueryIndex) => pins.length ? appendViewerNavigationPins({ ...local, localInstanceId }, pins) : local;
        };
        const params = {
          backend: request.backend,
          callerReason: "renderer-navigation-query",
          useSavedStartupInventory: request.query.kind === "group-members",
          includeStacks: navigationQueryShowsStacks(request.query, request.consumer),
          signal: rpcOptions?.signal,
        };
        const index = sidebar
          ? await loadSidebarNavigationQueryIndex({ ...params, viewerPins: summaries && { source: summaries, prepare, appendsPins: true } })
          : await loadLocalNavigationQueryIndex({ ...params, viewer: summaries && { source: summaries,
            project: async (local) => (await prepare())(local) } });
        rpcOptions?.signal.throwIfAborted();
        if (summaries) {
          // Drafts name threads on any instance. Peer rows come from the cache
          // that keeps pins current, so this read never waits on a peer.
          const watched = request.query.kind === "exact" && request.query.resolveFromOwners
            ? loadViewerWatchedNavigationRows(summaries, request.query.identities, index.threads,
                { cacheOnly: request.consumer === "exact-link" }) : [];
          if (!watched.length) return index;
          const localInstanceId = index.localInstanceId ?? (await getDesktopFederationRuntime().health()).instanceId;
          rpcOptions?.signal.throwIfAborted();
          // Watched rows join local project groups as pins do, so a selected
          // draft resolves its project. The index serves this one read only.
          return appendViewerNavigationPins({ ...index, localInstanceId }, watched);
        }
        return index;
      },
      request,
      scopeKey: request.inventory === "viewer" ? "renderer-viewer" : "renderer-local",
    });
  }

  async releaseNavigationAttentionView(request: NavigationAttentionViewReleaseRequest): Promise<void> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      return getDesktopFederationRuntime().remoteReleaseNavigationAttentionView(request.federationTarget, request);
    }
    getDesktopNavigationQueryStore().releaseAttentionView("renderer-local", request.viewId);
    getDesktopNavigationQueryStore().releaseAttentionView("renderer-viewer", request.viewId);
  }

  async markNavigationDirectorySeen(request: MarkNavigationDirectorySeenRequest): Promise<MarkNavigationDirectorySeenResponse> {
    const target = request.federationTarget;
    try {
      if (target && isRemoteFederationTarget(target)) {
        return await getDesktopFederationRuntime().remoteMarkNavigationDirectorySeen(target, request);
      }
      return await markLocalNavigationDirectorySeen(request);
    } catch (error) {
      const owner = getDesktopFederationRuntime().navigationActionOwnerLabel(target);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not mark ${request.directoryKey} read on ${owner}: ${message}`);
    }
  }

  async removeNavigationDirectory(request: RemoveNavigationDirectoryRequest): Promise<RemoveNavigationDirectoryResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      return getDesktopFederationRuntime().remoteRemoveNavigationDirectory(request.federationTarget, request);
    }
    return removeLocalNavigationDirectory(request, (member) => this.archiveThread(member));
  }

  async getNavigationLaunchpadConfig(
    request: NavigationLaunchpadConfigRequest,
    consumerId?: string,
  ): Promise<NavigationLaunchpadConfigResponse> {
    if (request.protocol !== 2) throw new Error("Navigation query protocol 2 is required. Upgrade this instance.");
    const token = consumerId ?? `service-exact:${++nextTransientNavigationConsumer}`;
    try {
      return await navigationQueryPool.readExact({ kind: "launchpad", consumerId: token,
        owner: request.federationTarget,
        identity: JSON.stringify([request.directoryKey ?? null]),
        operation: JSON.stringify([request.knownRevision ?? null]),
        load: async (options) => {
          if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
            return getDesktopFederationRuntime().remoteNavigationLaunchpadConfig(request.federationTarget, request, options);
          }
          return getDesktopNavigationDetailService().readLaunchpadConfig(request, { includeLocalAgentDraft: true });
        },
      });
    } finally { if (!consumerId) navigationQueryPool.release(token); }
  }

  async getNavigationSelectedDetail(
    request: NavigationSelectedDetailRequest,
    consumerId?: string,
  ): Promise<NavigationSelectedDetailResponse> {
    if (request.protocol !== 2) throw new Error("Navigation query protocol 2 is required. Upgrade this instance.");
    const token = consumerId ?? `service-exact:${++nextTransientNavigationConsumer}`;
    try {
      return await navigationQueryPool.readExact({ kind: "detail", consumerId: token,
        owner: request.federationTarget, ref: request.ref,
        identity: JSON.stringify([request.ref.backend, request.ref.threadId]),
        operation: JSON.stringify([request.knownRevision ?? null, request.probeWorkingStates === true,
          request.includeWorkspaceConfiguration === true, request.collection ?? null, request.lookup ?? null]),
        load: async (options) => {
          if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
            return getDesktopFederationRuntime().remoteNavigationSelectedDetail(request.federationTarget, request, options);
          }
          return getDesktopNavigationDetailService().readSelectedDetail(request, { signal: options.signal });
        },
      });
    } finally { if (!consumerId) navigationQueryPool.release(token); }
  }

  async getNavigationQueueProjection(
    request: NavigationQueueProjectionRequest,
    consumerId?: string,
  ): Promise<NavigationQueueProjection> {
    if (request.protocol !== 2) throw new Error("Navigation query protocol 2 is required. Upgrade this instance.");
    const token = consumerId ?? `service-exact:${++nextTransientNavigationConsumer}`;
    try {
      return await navigationQueryPool.readExact({ kind: "queue", consumerId: token,
        owner: request.federationTarget, ref: request.ref,
        identity: JSON.stringify([request.ref.backend, request.ref.threadId]),
        operation: JSON.stringify([request.knownRevision ?? null, request.cursor ?? null]),
        deadlineAt: request.deadlineAt,
        load: async (options) => {
          if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
            return getDesktopFederationRuntime().remoteNavigationQueueProjection(request.federationTarget, request, options);
          }
          return getDesktopNavigationDetailService().readQueueProjection(request);
        },
      });
    } finally { if (!consumerId) navigationQueryPool.release(token); }
  }

  setNavigationResumeState(state: NavigationResumeState): void {
    this.getOverlayStore().setNavigationResumeState?.(state);
  }

  async setNavigationBrowseMode(
    request: SetNavigationBrowseModeRequest,
  ): Promise<SetNavigationBrowseModeResponse> {
    const browseMode = await this.getOverlayStore().setNavigationBrowseMode(
      request.browseMode,
    );

    logDebug("setNavigationBrowseMode", { browseMode });

    return { browseMode };
  }

  async setPinnedGroupCollapsed(
    request: SetPinnedGroupCollapsedRequest,
  ): Promise<SetPinnedGroupCollapsedResponse> {
    const collapsed = await this.getOverlayStore().setPinnedGroupCollapsed?.(
      request.collapsed === true,
    ) ?? request.collapsed === true;
    return { collapsed };
  }

  /** The hourly sweep stopped archiving threads. Tell a profile once when it
   * had archived threads and had not turned automatic archiving off. */
  readAutomaticArchiveRetiredNotice(): DesktopAutomaticArchiveRetiredNotice {
    const store = this.getOverlayStore();
    const settings = getDesktopSettingsService();
    const show = store.getAutomaticArchiveRetiredNoticeSeenSync?.() === false
      && store.hasArchivedThreadsSync?.() === true
      && settings.resolveAutomaticArchiveWasOn();
    return { show, hibernationOn: settings.resolveCheckoutHibernationPolicy().enabled };
  }

  async dismissAutomaticArchiveRetiredNotice(): Promise<void> {
    await this.getOverlayStore().markAutomaticArchiveRetiredNoticeSeen?.();
  }

  async listRecentThreadLockNotes(): Promise<RecentThreadLockNotesResponse> {
    return { notes: this.getOverlayStore().listRecentThreadLockNotes?.() ?? [] };
  }

  /**
   * Remembers a note the operator saved in the lock dialog. Local to this
   * profile even when the thread lives on a peer: the operator typed it here.
   */
  async rememberThreadLockNote(
    request: ThreadLockNoteRequest,
  ): Promise<RecentThreadLockNotesResponse> {
    const note = readThreadLockNoteRequest(request);
    return {
      notes: await this.getOverlayStore().rememberRecentThreadLockNote?.(note) ?? [],
    };
  }

  /** Removes a note from the recent list, as a chip's remove button asks. */
  async forgetThreadLockNote(
    request: ThreadLockNoteRequest,
  ): Promise<RecentThreadLockNotesResponse> {
    const note = readThreadLockNoteRequest(request);
    return {
      notes: await this.getOverlayStore().forgetRecentThreadLockNote?.(note) ?? [],
    };
  }

  private async readNavigationSnapshot(
    request: GetNavigationSnapshotRequest,
  ): Promise<NavigationSnapshot> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const federationTarget = request.federationTarget;
      const cacheKey = getRemoteNavigationSnapshotCacheKey({
        ...request,
        federationTarget,
      });
      // Reserved before the peer round trip. Two navigation refreshes for one
      // peer can be in flight together and can finish out of order; without
      // this, the older snapshot's rows land last and revert a rename the
      // operator has already seen.
      // The same cache instance must both reserve and spend the sequence. A
      // federation restart between the two drops the cache, and the rebuilt
      // one counts from zero — every later refresh would then lose to this
      // one snapshot's high sequence and peer renames would stop appearing.
      const remoteThreadSummaries = getDesktopFederationRuntime()
        .remoteThreadSummaries();
      const nameObservationSequence =
        remoteThreadSummaries.reserveThreadNameObservation();
      try {
        const snapshot = await getDesktopFederationRuntime()
          .remoteNavigationSnapshot(
            federationTarget,
            {
              backend: request.backend === "all" ? undefined : request.backend,
              filter: request.filter,
            },
          );
        this.remoteNavigationSnapshotCache.set(cacheKey, snapshot);
        // A federation window reads its navigation here, not through
        // RemoteThreadSummaryCache, so this is the only place most remote
        // threads are ever named on this instance. Anything that later needs
        // a display name without paying for a peer round trip — the quit
        // dialog's blocker rows, for one — depends on this.
        //
        // Remembering a name is a side errand, never a reason to fail the
        // snapshot the operator actually asked for: the worst case of losing
        // it is a row that reads as a thread id somewhere else.
        try {
          remoteThreadSummaries.rememberThreadNames(
            federationTarget.instanceId,
            snapshot.threads,
            nameObservationSequence,
          );
        } catch (error) {
          logDebug("rememberRemoteThreadNames failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return await this.applyRemoteDirectoryViewerOverlays(
          snapshot,
          federationTarget.instanceId,
        );
      } catch (error) {
        if (!isFederationPeerUnavailableError(error)) {
          throw error;
        }
        const cached = this.remoteNavigationSnapshotCache.get(cacheKey);
        const fallback: NavigationSnapshot = cached ?? {
          backend: request.backend ?? "all",
          fetchedAt: Date.now(),
          federationTarget: request.federationTarget,
          unchanged: false,
          threads: [],
          inboxThreadKeys: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex",
            executionMode: "default",
          },
        };
        return await this.applyRemoteDirectoryViewerOverlays(
          {
            ...fallback,
            unchanged: false,
            threads: fallback.threads.map((thread) =>
              thread.federation
                ? {
                    ...thread,
                    federation: {
                      ...thread.federation,
                      peerStatus: "disconnected",
                    },
                  }
                : thread,
            ),
          },
          federationTarget.instanceId,
        );
      }
    }
    const backend: AppServerBackendScope = request.backend ?? "all";
    const threads = await getDesktopBackendRegistry().listThreads({
      backend: backend === "all" ? undefined : backend,
      callerReason: "navigation-snapshot",
      filter: request.filter,
      forceRefresh: request.forceRefresh,
    });
    const messagingBindingsByThreadKey = await buildMessagingBindingsByThreadKey(threads);
    const automationsByThreadKey = buildAutomationSummariesByThreadKey();
    const queuedExecutionModesByThreadKey = getDesktopBackendRegistry()
      .getQueuedExecutionModesSnapshot();
    const queuedTurnsByThreadKey = getDesktopBackendRegistry()
      .getQueuedTurnsSnapshot();
    const snapshot = await this.getOverlayStore().reconcileNavigationSnapshot({
      backend,
      automationsByThreadKey,
      fetchedAt: Date.now(),
      messagingBindingsByThreadKey,
      queuedExecutionModesByThreadKey,
      queuedTurnsByThreadKey,
      threads,
      workspaceRoots: resolveScratchProjectsRoots(),
    });
    await this.loadPrStatusRegistry();
    await this.threadPullRequestLookup.loadPrLookupRegistry();
    this.seedPrStatusRegistryFromThreads(snapshot.threads);
    const canonicalSnapshot = this.applyCanonicalPrStatuses(snapshot.threads);
    const replaceThreadPrAttachments =
      backend === "all" && !request.filter?.trim();
    await this.rememberThreadPrAttachments(canonicalSnapshot.threads, {
      replace: replaceThreadPrAttachments,
      resolveUnattached: true,
    });
    const threadsWithPrimaryGitRepositories =
      this.applyPrimaryGitRepositories(canonicalSnapshot.threads);
    const primaryGitRepositoriesChanged =
      this.rememberPublishedPrimaryGitRepositories(
        threadsWithPrimaryGitRepositories,
        { replace: replaceThreadPrAttachments },
      );
    void this.getPrAutoDispatchCoordinator().resume();
    await this.directoryGitStatus.loadDirectoryGitStatusCache();
    const { directories: ownerDirectories } = await reconcileWindowsDirectoryAliases(snapshot.directories, snapshot.threads);
    for (const directory of ownerDirectories) {
      this.lastDirectoriesByKey.set(directory.key, directory);
    }
    const directories = await hydrateDirectoryLaunchpads(
      ownerDirectories.map((directory) => this.directoryGitStatus.applyCachedStatus(directory)),
    );
    const previousDirectories = this.previousDirectoriesByBackend.get(backend);
    const directoriesUnchanged = previousDirectories
      ? directoryStatusesEqual(previousDirectories, directories)
      : false;
    this.previousDirectoriesByBackend.set(backend, directories);
    this.directoryGitStatus.startDirectoryGitStatusRefresh({
      automatic: true,
      directories: ownerDirectories,
      requestKey: getNavigationSnapshotRequestKey(request),
    });

    await this.loadThreadGitWorkingStateCache();
    this.rememberThreadWorktreePaths(canonicalSnapshot.threads);
    this.rememberThreadPrRefreshContexts(canonicalSnapshot.threads);
    this.syncPrPollingSchedulerState();
    const detachedPrsByThreadKey = await this.readDetachedPrsByThreadKey(
      canonicalSnapshot.threads,
    );
    this.rememberPublishedPrCommitShas(
      canonicalSnapshot.threads,
      detachedPrsByThreadKey,
    );
    const threadsWithWorkingState = await getDesktopBackendRegistry()
      .hydrateThreadGitWorkingStates(
        threadsWithPrimaryGitRepositories.map((thread) =>
          this.applyCachedWorktreeWorkingState(thread),
        ),
      );
    // The registry owns the one automatic fleet round shared by renderer,
    // messaging, and federated navigation. Focused, user, and event-driven
    // refreshes still use this window's single-worktree lane below.
    void getDesktopBackendRegistry()
      .refreshThreadGitWorkingStates(canonicalSnapshot.threads)
      .catch((error) => {
        logDebug("worktreeWorkingStateRefresh:failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    const { stacks } = await this.stackReader.read(threadsWithWorkingState, this.knownStackPullRequests(), undefined,
      (key) => this.stackThreadActivity(key));
    if (replaceThreadPrAttachments) this.publishedStacks = stacks;
    const memberships = stackMemberships(stacks);
    const threadsWithStacks = threadsWithWorkingState.map((thread) => {
      const stacks = memberships.get(buildThreadIdentityKey(thread.source, thread.id));
      return stacks ? { ...thread, stacks } : thread;
    });
    const remotePins = await this.mergePinnedRemoteThreads();

    const registry = getDesktopBackendRegistry();
    const providerRefresh =
      backend === "all"
      && !request.filter?.trim()
      && typeof registry.getStartupProviderRefreshStatus === "function"
        ? registry.getStartupProviderRefreshStatus()
        : undefined;
    const responseWithoutLiveTokenMiser = {
      ...snapshot,
      threads: [...threadsWithStacks, ...remotePins.threads],
      // One unified ranking over local + remote rows: the local keys were
      // computed by this same function inside the reconcile, so re-ranking
      // the combined set preserves their order while letting a fresher
      // remote unread outrank stale local entries instead of always
      // trailing them.
      inboxThreadKeys:
        remotePins.threads.length === 0
          ? snapshot.inboxThreadKeys
          : rankInboxThreadKeys([
              ...threadsWithWorkingState,
              ...remotePins.threads,
            ]),
      directories: attachRemoteThreadsToLocalDirectories(
        directories,
        remotePins.threads,
      ),
      unchanged:
        snapshot.unchanged
        && directoriesUnchanged
        && !canonicalSnapshot.changed
        && !primaryGitRepositoriesChanged
        && !remotePins.changed,
      ...(providerRefresh ? { providerRefresh } : {}),
    };
    const response = typeof registry.withLiveTokenMiserNavigationSnapshot
      === "function"
      ? registry.withLiveTokenMiserNavigationSnapshot(
          responseWithoutLiveTokenMiser,
        )
      : responseWithoutLiveTokenMiser;
    if (
      backend === "all"
      && !request.filter?.trim()
    ) {
      // Creation-time visibility and append-rank decisions must see the same
      // merged local + viewer-owned remote pin list the renderer sees.
      getDesktopBackendRegistry().rememberCompleteNavigationSnapshot(response);
    }
    return response;
  }

  private async applyRemoteDirectoryViewerOverlays(
    snapshot: NavigationSnapshot,
    instanceId: string,
  ): Promise<NavigationSnapshot> {
    const overlays = await this.getOverlayStore().readRemoteDirectoryOverlays({
      instanceId,
    });
    let changed = false;
    const directories = snapshot.directories.map((directory) => {
      const collapsed = overlays[directory.key]?.directoryThreadsCollapsed;
      // The owner's Forge Automation stays on its rows; only the disclosure
      // is this viewer's own.
      if (collapsed === undefined || directory.directoryThreadsCollapsed === collapsed) {
        return directory;
      }
      changed = true;
      return { ...directory, directoryThreadsCollapsed: collapsed };
    });
    return changed
      ? {
          ...snapshot,
          directories,
          // The owner's unchanged hash does not include viewer-local state.
          unchanged: false,
        }
      : snapshot;
  }

  /**
   * Viewer-side remote thread pins, merged into the main window's snapshot.
   * Reachable owners serve their cached stamped rows (and refresh the
   * cached pin payload); unreachable owners fall back to the persisted
   * payload stamped with their current non-connected status so rows render
   * dimmed. The merge never awaits a peer — stale summaries refetch in the
   * background and land via `navigation/remoteThreadPins/changed`, so
   * navigation refresh latency stays independent of peer responsiveness.
   * The merged rows get their own change hash so a peer-side
   * title/PR/reaction/status change can never be suppressed by the local
   * `unchanged` optimization.
   */
  private async mergePinnedRemoteThreads(): Promise<{
    threads: NavigationThreadSummary[];
    changed: boolean;
  }> {
    let resolved: { threads: NavigationThreadSummary[] } = { threads: [] };
    try {
      const overlayStore = this.getOverlayStore();
      const pins =
        typeof overlayStore.listRemoteThreadPins === "function"
          ? await overlayStore.listRemoteThreadPins({ includeMountTokens: true })
          : [];
      if (pins.length > 0) {
        const cache = getDesktopFederationRuntime().remoteThreadSummaries();
        const resolution = await cache.resolvePinnedThreads(pins);
        // The owner's pinnedRank describes ITS pinned section — carrying it
        // over would promote the row into the viewer's Pins section by a
        // foreign rank and wire the pin chip to an owner-side unpin. Replace
        // it with the VIEWER-owned rank from the pin row (usually absent):
        // pin or unpin locally and only the viewer knows. The remote-viewer
        // window path is untouched — owner semantics are correct there.
        const localRankByKey = new Map(
          pins.map((pin) => [
            federatedThreadIdentityKey(pin.ref),
            pin.localPinnedRank,
          ]),
        );
        resolved = {
          ...resolution,
          threads: resolution.threads.map(
            ({ pinnedRank: _pinnedRank, ...thread }) => {
              const localRank = localRankByKey.get(
                thread.federation?.ref
                  ? federatedThreadIdentityKey(thread.federation.ref)
                  : buildThreadIdentityKey(thread.source, thread.id),
              );
              return localRank ? { ...thread, pinnedRank: localRank } : thread;
            },
          ),
        };
        if (resolution.archived.length > 0) {
          await Promise.all(
            archivedRemoteThreadPinMounts(pins, resolution.archived).map(async (mount) => {
              if (await overlayStore.removeRemoteThreadPin(mount)) resolution.acknowledgeArchiveDeletion?.(mount);
            }),
          );
        }
        if (resolution.refreshed.length > 0) {
          await this.getOverlayStore().updateRemoteThreadPinSnapshots(
            resolution.refreshed,
          );
        }
      }
    } catch (error) {
      appServerLog.warn("Pinned remote thread merge failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const hash = JSON.stringify(
      resolved.threads.map((thread) => ({
        id: thread.id,
        source: thread.source,
        title: thread.title,
        updatedAt: thread.updatedAt,
        threadStatus: thread.threadStatus,
        inbox: thread.inbox,
        prs: thread.prs,
        federation: thread.federation,
        reactions: thread.reactions,
        parentThreadId: thread.parentThreadId,
        parentThreadBackend: thread.parentThreadBackend,
        parentThreadInstanceId: thread.parentThreadInstanceId,
        // Viewer-owned rank: a local pin/unpin must invalidate the snapshot.
        pinnedRank: thread.pinnedRank,
        // Directory-group membership derives from these; a peer-side project
        // change must invalidate the snapshot like a title change does.
        linkedDirectories: thread.linkedDirectories,
      })),
    );
    const changed = hash !== this.lastRemoteThreadPinsMergeHash;
    this.lastRemoteThreadPinsMergeHash = hash;
    return { threads: resolved.threads, changed };
  }

  async resolveEditCommitStates(
    request: ResolveEditCommitStatesRequest,
  ): Promise<ResolveEditCommitStatesResponse> {
    const acceptedPushedCommitShas = this.getPublishedPrCommitShasForWorktree(
      request.worktreePath,
    );
    // Coalesce identical in-flight requests (same worktree + groups) so an
    // overlapping renderer re-resolve doesn't spawn a second git burst — they
    // share one result.
    const requestKey = JSON.stringify({
      worktreePath: request.worktreePath,
      groups: request.groups,
      acceptedPushedCommitShas,
    });
    const pending = this.pendingEditCommitResolves.get(requestKey);
    if (pending) {
      return await pending;
    }

    const promise = getDesktopBackendRegistry()
      .resolveEditCommitStates(request.worktreePath, request.groups, {
        acceptedPushedCommitShas,
      })
      .then((states) => ({ states }));
    this.pendingEditCommitResolves.set(requestKey, promise);
    try {
      return await promise;
    } finally {
      this.pendingEditCommitResolves.delete(requestKey);
    }
  }

  async listWorktreeOtherChanges(
    request: ListWorktreeOtherChangesRequest,
  ): Promise<ListWorktreeOtherChangesResponse> {
    return await getDesktopBackendRegistry().listWorktreeOtherChanges(
      request.worktreePath,
      {
        excludePaths: request.excludePaths,
        maxFiles: request.maxFiles,
      },
    );
  }

  async getWorktreeOtherChangeDiff(
    request: GetWorktreeOtherChangeDiffRequest,
  ): Promise<GetWorktreeOtherChangeDiffResponse> {
    return await getDesktopBackendRegistry().getWorktreeOtherChangeDiff(
      request.worktreePath,
      request.path,
      { maxBytes: request.maxBytes },
    );
  }

  async listWorktreeUnpublishedCommits(
    request: ListWorktreeUnpublishedCommitsRequest,
  ): Promise<ListWorktreeUnpublishedCommitsResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      if (!request.backend || !request.threadId?.trim()) {
        throw new Error(
          "Remote unpublished commit reads require an owning thread identity.",
        );
      }
      return await getDesktopFederationRuntime()
        .remoteBackend(request.federationTarget)
        .listWorktreeUnpublishedCommits({
          backend: request.backend,
          threadId: request.threadId,
          worktreePath: request.worktreePath,
          maxCommits: request.maxCommits,
          maxFilesPerCommit: request.maxFilesPerCommit,
        });
    }
    return await getDesktopBackendRegistry().listWorktreeUnpublishedCommits(
      request.worktreePath,
      {
        acceptedPushedCommitShas: this.getPublishedPrCommitShasForWorktree(
          request.worktreePath,
        ),
        maxCommits: request.maxCommits,
        maxFilesPerCommit: request.maxFilesPerCommit,
      },
    );
  }

  async readWorktreeImage(
    request: ReadWorktreeImageRequest,
  ): Promise<ReadWorktreeImageResponse> {
    return await readWorktreeImage(request);
  }

  async getWorktreeUnpublishedCommitDiff(
    request: GetWorktreeUnpublishedCommitDiffRequest,
  ): Promise<GetWorktreeUnpublishedCommitDiffResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      if (!request.backend || !request.threadId?.trim()) {
        throw new Error(
          "Remote unpublished commit reads require an owning thread identity.",
        );
      }
      return await getDesktopFederationRuntime()
        .remoteBackend(request.federationTarget)
        .getWorktreeUnpublishedCommitDiff({
          backend: request.backend,
          threadId: request.threadId,
          worktreePath: request.worktreePath,
          commitSha: request.commitSha,
          path: request.path,
          maxBytes: request.maxBytes,
        });
    }
    return await getDesktopBackendRegistry().getWorktreeUnpublishedCommitDiff(
      request.worktreePath,
      request.commitSha,
      request.path,
      {
        acceptedPushedCommitShas: this.getPublishedPrCommitShasForWorktree(
          request.worktreePath,
        ),
        maxBytes: request.maxBytes,
      },
    );
  }

  private rememberThreadWorktreePaths(
    threads: NavigationSnapshot["threads"],
  ): void {
    for (const thread of threads) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const worktreePath = this.resolveThreadWorkingStatePath(thread);
      if (worktreePath) {
        this.worktreePathByThreadKey.set(threadKey, worktreePath);
      } else {
        this.worktreePathByThreadKey.delete(threadKey);
      }
    }
  }

  private rememberThreadPrRefreshContexts(
    threads: NavigationSnapshot["threads"],
  ): void {
    for (const thread of threads) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const contexts = resolveThreadPullRequestContexts(thread);
      if (contexts.length === 0) {
        this.prRefreshContextByThreadKey.delete(threadKey);
        continue;
      }
      this.prRefreshContextByThreadKey.set(threadKey, contexts);
    }
  }

  /**
   * `pullRequestMatchesRepositoryKey` for a thread's primary repository. A
   * checkout whose remote still uses a renamed repository's old name holds the
   * repository the forge reports PRs under, so once the forge has named it,
   * both sides compare under its current name.
   */
  private matchesPrimaryRepository(pr: PrSummary, primaryRepoKey: string | undefined): boolean {
    if (pullRequestMatchesRepositoryKey(pr, primaryRepoKey)) return true;
    if (!primaryRepoKey || !this.prRepositoryAliases.hasRenames()) return false;
    return pullRequestMatchesRepositoryKey(
      this.prRepositoryAliases.canonicalize(pr),
      this.prRepositoryAliases.canonicalizeRepositoryKey(primaryRepoKey),
    );
  }

  /** A primary repository key under the forge's current name. */
  private canonicalPrimaryRepoKey(primaryRepoKey: string | undefined): string | undefined {
    return primaryRepoKey && this.prRepositoryAliases.canonicalizeRepositoryKey(primaryRepoKey);
  }

  private setThreadPrAttachment(
    threadKey: string,
    attachment: ThreadPrAttachment | undefined,
  ): void {
    const identity = parseThreadIdentityKey(threadKey);
    // An in-flight lookup can finish after archive removed the subscription.
    if (attachment && identity && getDesktopBackendRegistry().getThreadInfo(identity)?.archived === true) attachment = undefined;
    this.primaryPrThreadsByKey.set(threadKey, (attachment?.prs ?? [])
      .filter((pr) => this.matchesPrimaryRepository(pr, attachment?.primaryRepoKey))
      .map((pr) => getPrStatusKey(this.prRepositoryAliases.canonicalize(pr))));
    if (attachment) this.attachedPrsByThreadKey.set(threadKey, attachment);
    else this.attachedPrsByThreadKey.delete(threadKey);
  }

  private async rememberThreadPrAttachments(
    threads: NavigationSnapshot["threads"],
    options: { replace: boolean; isCurrent?: () => boolean; resolveUnattached?: boolean; inventoryDemand?: PrMetadataDemand },
  ): Promise<void> {
    const inventoryConfig = options.inventoryDemand && createInventoryRemoteConfigReader();
    const primaryRepoResolutionByPath = new Map<string, Promise<string | undefined>>();
    const freshPrimaryRepoResolutionByPath = new Map<string, Promise<string | undefined>>();
    const storedRepositories = options.inventoryDemand
      ? threads.map((thread) => thread.prs?.length ? readStoredPrimaryThreadRepository(thread) : undefined)
      : undefined;
    const primaryRepoKeys = await Promise.all(threads.map((thread, index) => {
      if (!options.inventoryDemand) {
        return thread.prs?.length || options.resolveUnattached
          ? resolvePrimaryThreadRepoKey(thread, primaryRepoResolutionByPath)
          : undefined;
      }
      const stored = storedRepositories?.[index];
      if (!stored || !thread.prs?.length) return undefined;
      const previous = this.attachedPrsByThreadKey.get(buildThreadIdentityKey(thread.source, thread.id));
      const workspaceChanged = previous?.workspace && primaryCheckoutKey(previous.workspace) !== primaryCheckoutKey(thread);
      const live = thread.prs.filter((pr) => !isTerminalPullRequest(pr));
      // Terminal attachments still need primary identity to arbitrate status
      // from peers. A saved origin can also name an unexpanded SSH alias.
      const unresolved = !stored.key || (live.length > 0
        && !live.some((pr) => this.matchesPrimaryRepository(pr, stored.key)));
      return workspaceChanged || (stored.canProbe && unresolved)
        ? prGitSubprocessCaller.run("pr-owner-navigation-inventory", () =>
            resolvePrimaryThreadRepoKey(thread, workspaceChanged ? freshPrimaryRepoResolutionByPath : primaryRepoResolutionByPath, {
              demand: options.inventoryDemand, ...(workspaceChanged ? { fresh: true } : { inventoryConfig }),
            }))
        : stored.key;
    }));
    const liveThreadKeys = new Set<string>();
    const candidates: Array<{ backend: AppServerBackendKind; threadId: string; prKeys: string[] }> = [];
    for (const [index, thread] of threads.entries()) {
      if (options.isCurrent && !options.isCurrent()) return;
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      liveThreadKeys.add(threadKey);
      const stored = storedRepositories?.[index];
      const current = stored && readStoredPrimaryThreadRepository(thread);
      // A checkout read can supersede inventory while the rest of the batch
      // is still running. A new conclusive absence also replaces an old key.
      const primaryRepoKey = current?.conclusiveSampleOrder !== undefined
        && current.conclusiveSampleOrder > (stored?.conclusiveSampleOrder ?? 0) ? current.key : primaryRepoKeys[index];
      this.setThreadPrAttachment(threadKey, {
        backend: thread.source,
        workspace: { gitOriginUrl: thread.gitOriginUrl, linkedDirectories: thread.linkedDirectories },
        ...(primaryRepoKey ? { primaryRepoKey } : {}),
        prs: thread.prs ?? [],
      });
      candidates.push({
        backend: thread.source,
        threadId: thread.id,
        prKeys: this.autoFixCandidatePrKeys(thread.prs ?? [], primaryRepoKey),
      });
    }
    if (options.replace) {
      for (const threadKey of this.attachedPrsByThreadKey.keys()) {
        if (options.isCurrent && !options.isCurrent()) return;
        if (!liveThreadKeys.has(threadKey)) {
          this.setThreadPrAttachment(threadKey, undefined);
          const identity = parseThreadIdentityKey(threadKey);
          if (identity) {
            candidates.push({ ...identity, prKeys: [] });
          }
        }
      }
    }
    if (options.isCurrent && !options.isCurrent()) return;
    this.publishPrAutoFixCandidateChanges(
      await this.getOverlayStore().syncThreadPrAutoDispatchCandidatesBatch({ threads: candidates, now: Date.now() }),
    );
  }

  private async rememberThreadPrAttachmentUpdate(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prs: PrSummary[];
  }): Promise<void> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.attachedPrsByThreadKey.get(threadKey);
    // Write the PR list before any await so overlapping updates keep their
    // arrival order.
    this.setThreadPrAttachment(
      threadKey,
      {
        ...current,
        backend: params.backend,
        prs: params.prs,
      },
    );
    if (params.prs.length > 0 && !current?.primaryRepoKey) {
      const primaryRepoKey = (await this.resolveUncachedPrimaryRepository(params))?.key;
      // Patch only the key onto whatever list is now current. A refresh may
      // have supplied a key, or dropped the thread, while this resolved.
      const latest = this.attachedPrsByThreadKey.get(threadKey);
      if (primaryRepoKey && latest && latest.workspace === current?.workspace && !latest.primaryRepoKey) {
        this.setThreadPrAttachment(threadKey, { ...latest, primaryRepoKey });
      }
    }
    await this.syncThreadPrAutoDispatchCandidates(params);
  }

  /**
   * The owner navigation refresh normally supplies a thread's primary
   * repository. A thread created mid-session can attach and watch a PR before
   * that refresh lists it; without this, its PR would not count as primary
   * and the watch tool would refuse it until the next refresh.
   */
  private async resolveUncachedPrimaryRepository(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }, demand?: PrMetadataDemand, overlay?: ThreadOverlayState, fresh = false) {
    const summary = getDesktopBackendRegistry().getCachedThreadSummary(params)
      ?? this.attachedPrsByThreadKey.get(buildThreadIdentityKey(params.backend, params.threadId))?.workspace;
    if (!summary) return undefined;
    overlay ??= await this.getOverlayStore().getThreadOverlayState(params);
    const workspace = {
      gitOriginUrl: summary.gitOriginUrl,
      linkedDirectories: mergeThreadLinkedDirectories([
        ...summary.linkedDirectories,
        ...(overlay?.extraLinkedDirectories ?? []),
      ]),
    };
    let sampleOrder: number | undefined;
    const key = await resolvePrimaryThreadRepoKey(workspace, undefined, demand ? {
      demand, confirmEmpty: true, ...(fresh ? { fresh } : {}),
      onOriginSample: (order) => { sampleOrder = order; },
    } : undefined);
    return { key, workspace, sampleOrder };
  }

  /** Repository authority for forge rules, resolved from the current workspace. */
  async resolvePrimaryGitRepository(backend: AppServerBackendKind, threadId: string): Promise<string | undefined> {
    return this.canonicalPrimaryRepoKey((await this.resolveUncachedPrimaryRepository(
      { backend, threadId }, { priority: () => PR_METADATA_PRIORITY.selected },
    ))?.key);
  }

  readPrimaryGitRepository(backend: AppServerBackendKind, threadId: string): string | undefined {
    return this.canonicalPrimaryRepoKey(
      this.attachedPrsByThreadKey.get(buildThreadIdentityKey(backend, threadId))?.primaryRepoKey,
    );
  }

  private applyPrimaryGitRepositories(
    threads: NavigationSnapshot["threads"],
  ): NavigationSnapshot["threads"] {
    return threads.map((thread) => {
      const primaryGitRepository = this.canonicalPrimaryRepoKey(this.attachedPrsByThreadKey.get(
        buildThreadIdentityKey(thread.source, thread.id),
      )?.primaryRepoKey);
      return primaryGitRepository
        ? { ...thread, primaryGitRepository }
        : thread;
    });
  }

  private rememberPublishedPrimaryGitRepositories(
    threads: NavigationSnapshot["threads"],
    options: { replace: boolean },
  ): boolean {
    const liveThreadKeys = new Set<string>();
    let changed = false;
    for (const thread of threads) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      const primaryGitRepository = thread.primaryGitRepository;
      liveThreadKeys.add(threadKey);
      if (
        !this.publishedPrimaryGitRepositoriesByThreadKey.has(threadKey)
        || this.publishedPrimaryGitRepositoriesByThreadKey.get(threadKey) !==
          primaryGitRepository
      ) {
        changed = true;
        this.publishedPrimaryGitRepositoriesByThreadKey.set(
          threadKey,
          primaryGitRepository,
        );
      }
    }
    if (options.replace) {
      for (const threadKey of this.publishedPrimaryGitRepositoriesByThreadKey.keys()) {
        if (!liveThreadKeys.has(threadKey)) {
          changed = true;
          this.publishedPrimaryGitRepositoriesByThreadKey.delete(threadKey);
        }
      }
    }
    return changed;
  }

  /**
   * The PRs a thread stands for in Auto-fix election: those of its primary
   * repository, less any the operator switched off for this thread alone.
   */
  private autoFixCandidatePrKeys(prs: PrSummary[], primaryRepoKey: string | undefined): string[] {
    return prs
      .filter((pr) => pr.autoFixOff !== true && this.matchesPrimaryRepository(pr, primaryRepoKey))
      .map(getPrStatusKey);
  }

  private async syncThreadPrAutoDispatchCandidates(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<PrAutoDispatchCandidateChange[]> {
    const attachment = this.attachedPrsByThreadKey.get(
      buildThreadIdentityKey(params.backend, params.threadId),
    );
    const prKeys = attachment
      ? this.autoFixCandidatePrKeys(attachment.prs, attachment.primaryRepoKey)
      : [];
    const changes = await this.getOverlayStore().syncThreadPrAutoDispatchCandidates({
      ...params,
      prKeys,
      now: Date.now(),
    });
    this.publishPrAutoFixCandidateChanges(changes);
    return changes;
  }

  /**
   * Auto-fix candidacy changed after a window may have listed it. Each
   * thread holding an affected PR re-lists: one thread's candidacy can move
   * another between active and handled by another thread.
   */
  private publishPrAutoFixCandidateChanges(
    changes: PrAutoDispatchCandidateChange[] | undefined,
  ): void {
    if (!changes?.length) return;
    void (async () => {
      const prKeys = new Set(changes.map((change) => change.prKey));
      const holders = (await this.getOverlayStore().listPrAutoDispatchCandidates())
        .filter((candidate) => prKeys.has(candidate.prKey));
      const threads = new Map<string, { backend: AppServerBackendKind; threadId: string }>();
      for (const thread of [...changes, ...holders]) {
        threads.set(buildThreadIdentityKey(thread.backend, thread.threadId), {
          backend: thread.backend,
          threadId: thread.threadId,
        });
      }
      await this.publishPrWatchesUpdated([...threads.values()]);
    })().catch((error: unknown) => {
      appServerLog.warn("failed to publish Auto-fix candidate change", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * These PRs merged, closed or reopened. Auto-fix on each one changes
   * between live and idle, so every thread holding it re-lists.
   */
  private publishPrAutoFixPrEndedChanges(prKeys: ReadonlySet<string>): void {
    if (prKeys.size === 0 || !this.backgroundPrPollingEnabled || !this.prAutoDispatchAllowed) return;
    void (async () => {
      const holders = (await this.getOverlayStore().listPrAutoDispatchCandidates())
        .filter((candidate) => prKeys.has(candidate.prKey));
      await this.publishPrWatchesUpdated(holders.map((holder) => ({
        backend: holder.backend,
        threadId: holder.threadId,
      })));
    })().catch((error: unknown) => {
      appServerLog.warn("failed to publish Auto-fix PR end", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Recheck the checkout and its own attachments on the action path. */
  private async readPrimaryAttachedPrs(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }, fresh = true): Promise<{ overlay: ThreadOverlayState | undefined; prs: PrSummary[]; primaryRepoKey?: string }> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const before = this.attachedPrsByThreadKey.get(threadKey);
    const overlay = await this.getOverlayStore().getThreadOverlayState(params);
    if (!overlay?.prs?.length) return { overlay, prs: [] };
    const demand = { priority: () => PR_METADATA_PRIORITY.selected };
    const repository = await this.resolveUncachedPrimaryRepository(params, demand, overlay, fresh);
    const primaryRepoKey = repository?.key;
    const prs = await this.canonicalizeStoredPullRequests(overlay.prs, demand);
    const latest = this.attachedPrsByThreadKey.get(threadKey);
    if (before && (!latest || (before.workspace && latest.workspace
      && primaryCheckoutKey(before.workspace) !== primaryCheckoutKey(latest.workspace)))) {
      return { overlay, prs: [] };
    }
    const updatedKeys = latest && latest !== before
      ? new Set(latest.prs.map((pr) => this.prRepositoryAliases.canonicalizeKey(getPrStatusKey(pr))))
      : undefined;
    // The action uses its own checkout result. Polling may already have a
    // newer conclusive origin or a newer confirmation that origin is absent.
    let pollingRepoKey = primaryRepoKey;
    if (repository?.sampleOrder !== undefined) {
      const observed = readStoredPrimaryThreadRepository(repository.workspace);
      if ((observed.conclusiveSampleOrder ?? 0) > repository.sampleOrder) pollingRepoKey = observed.key;
    }
    this.setThreadPrAttachment(threadKey, {
      backend: params.backend, prs: this.canonicalizePrs(overlay.prs), ...latest,
      primaryRepoKey: pollingRepoKey,
    });
    return { overlay, primaryRepoKey, prs: prs.filter((pr) =>
      this.matchesPrimaryRepository(pr, primaryRepoKey) && (!updatedKeys || updatedKeys.has(getPrStatusKey(pr))),
    ) };
  }

  /**
   * The thread's checkout head when it is past the PR head the status cache
   * holds, else undefined. Git failures read as undefined.
   */
  private async readPushedPrHeadSha(params: {
    backend: AppServerBackendKind;
    threadId: string;
    pr: PrSummary;
    headSha: string;
    overlay: ThreadOverlayState | undefined;
  }): Promise<string | undefined> {
    const summary = getDesktopBackendRegistry().getCachedThreadSummary(params);
    const directories = params.pr.linkedDirectoryPaths?.length
      ? params.pr.linkedDirectoryPaths
      : resolveThreadPullRequestDirectoryPaths({
          linkedDirectories: [
            ...(summary?.linkedDirectories ?? []),
            ...(params.overlay?.extraLinkedDirectories ?? []),
          ],
        });
    return await readLocalHeadPastPrHead({
      directories: directories.slice(0, 4),
      cachedHeadSha: params.headSha,
      ...(params.pr.headRefName ? { headRefName: params.pr.headRefName } : {}),
    });
  }

  private primaryAttachedPrsForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prs: PrSummary[];
  }): PrSummary[] {
    const attachment = this.attachedPrsByThreadKey.get(
      buildThreadIdentityKey(params.backend, params.threadId),
    );
    return params.prs.filter((pr) =>
      this.matchesPrimaryRepository(pr, attachment?.primaryRepoKey),
    );
  }

  private async isPrimaryPrAttached(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prKey: string;
  }, fresh = true): Promise<boolean> {
    const { prs } = await this.readPrimaryAttachedPrs(params, fresh);
    return prs.some((pr) => getPrStatusKey(pr) === this.prRepositoryAliases.canonicalizeKey(params.prKey));
  }

  private applyPrStatusToAttachments(pr: PrSummary): void {
    const prKey = getPrStatusKey(pr);
    for (const [threadKey, attachment] of this.attachedPrsByThreadKey) {
      let changed = false;
      const prs = attachment.prs.map((candidate) => {
        if (getPrStatusKey(candidate) !== prKey) return candidate;
        changed = true;
        return normalizePrSummary({
          ...pr,
          linkedDirectoryPaths: candidate.linkedDirectoryPaths,
          ...pullRequestAttachmentIntent(candidate),
        });
      });
      if (changed) {
        this.attachedPrsByThreadKey.set(threadKey, { ...attachment, prs });
      }
    }
  }

  private async readDetachedPrsByThreadKey(
    threads: NavigationSnapshot["threads"],
  ): Promise<Map<string, PrSummary[]>> {
    const threadIdsByBackend = new Map<AppServerBackendKind, Set<string>>();
    for (const thread of threads) {
      const threadIds = threadIdsByBackend.get(thread.source) ?? new Set<string>();
      threadIds.add(thread.id);
      threadIdsByBackend.set(thread.source, threadIds);
    }

    const detachedPrsByThreadKey = new Map<string, PrSummary[]>();
    await Promise.all(
      [...threadIdsByBackend.entries()].map(async ([backend, threadIds]) => {
        const detached = this.getOverlayStore().readDetachedThreadPullRequests({
          backend,
          threadIds: [...threadIds],
        });
        for (const [threadId, prs] of Object.entries(detached)) {
          if (prs.length) {
            detachedPrsByThreadKey.set(
              buildThreadIdentityKey(backend, threadId),
              prs,
            );
          }
        }
      }),
    );
    return detachedPrsByThreadKey;
  }

  private rememberPublishedPrCommitShas(
    threads: NavigationSnapshot["threads"],
    detachedPrsByThreadKey: Map<string, PrSummary[]> = new Map(),
  ): void {
    for (const thread of threads) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      this.rememberPublishedPrCommitShasForThread({
        backend: thread.source,
        threadId: thread.id,
        worktreePath: this.resolveThreadWorkingStatePath(thread),
        prs: [
          ...(thread.prs ?? []),
          ...(detachedPrsByThreadKey.get(threadKey) ?? []),
        ],
      });
    }
  }

  private rememberPublishedPrCommitShasForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    worktreePath?: string;
    prs: PrSummary[];
  }): string | undefined {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const worktreePath = params.worktreePath?.trim()
      || this.worktreePathByThreadKey.get(threadKey);
    if (!worktreePath) {
      this.publishedPrCommitsByThread.delete(threadKey);
      return undefined;
    }
    const prs = this.canonicalizePrs(params.prs);
    if (prs.length === 0) {
      this.publishedPrCommitsByThread.delete(threadKey);
      return worktreePath;
    }
    this.publishedPrCommitsByThread.set(threadKey, {
      worktreePath,
      prs,
    });
    return worktreePath;
  }

  private getPublishedPrCommitShasForWorktree(worktreePath: string): string[] {
    const accepted = new Set<string>();
    const normalizedWorktreePath = worktreePath.trim();
    for (const entry of this.publishedPrCommitsByThread.values()) {
      if (entry.worktreePath !== normalizedWorktreePath) {
        continue;
      }
      for (const sha of publishedPrCommitShas(this.canonicalizePrs(entry.prs))) {
        accepted.add(sha);
      }
    }
    return [...accepted];
  }

  private applyCachedWorktreeWorkingState(
    thread: NavigationSnapshot["threads"][number],
  ): NavigationSnapshot["threads"][number] {
    const worktreePath = this.resolveThreadWorkingStatePath(thread);
    const cached = worktreePath
      ? getDesktopBackendRegistry()
          .getThreadGitWorkingStateCache()
          .get(worktreePath)
      : undefined;
    // Threads arrive without working state (the enricher no longer computes
    // it), so hydration only ever adds the cached value. A worktree the cache
    // doesn't know about yet shows no chips until the background probe lands.
    if (cached) {
      return {
        ...thread,
        gitWorkingStateFetchedAt: cached.fetchedAt,
        ...(cached.gitWorkingState
          ? { gitWorkingState: cached.gitWorkingState }
          : {}),
      };
    }
    return thread;
  }

  private resolveThreadWorkingStatePath(
    thread: Pick<
      NavigationSnapshot["threads"][number],
      "projectKey" | "linkedDirectories"
    >,
  ): string | undefined {
    const projectKey = thread.projectKey?.trim();
    if (projectKey) {
      return projectKey;
    }

    for (const directory of thread.linkedDirectories ?? []) {
      const worktreePath = directory.worktreePath?.trim();
      if (worktreePath) {
        return worktreePath;
      }
    }

    for (const directory of thread.linkedDirectories ?? []) {
      if (directory.kind !== "local") {
        continue;
      }
      const directoryPath = directory.path?.trim();
      if (directoryPath) {
        return directoryPath;
      }
    }

    return undefined;
  }

  refreshDirectoryGitStatusesForKeys(request: RefreshDirectoryGitStatusesRequest): Promise<RefreshDirectoryGitStatusesResponse> {
    return this.directoryGitStatus.refreshDirectoryGitStatusesForKeys(request);
  }

  writeDirectoryGitStatusEntry(
    params: Parameters<DesktopDirectoryGitStatus["writeDirectoryGitStatusEntry"]>[0],
  ): Promise<void> {
    return this.directoryGitStatus.writeDirectoryGitStatusEntry(params);
  }

  /**
   * The registry owns the cache both refresh lanes read. This window's lane
   * used to keep a second copy, loaded exactly once and never re-read, so a
   * registry-lane probe landing after startup was invisible here: the stale
   * pre-stamp from `applyCachedWorktreeWorkingState` satisfied the registry's
   * own `if (thread.gitWorkingState)` short-circuit and the newer value was
   * dropped.
   */
  private async loadThreadGitWorkingStateCache(): Promise<void> {
    await getDesktopBackendRegistry().loadThreadGitWorkingStateCache();
  }

  /**
   * Schedule focused, user-triggered, and event-triggered probes through the
   * registry's shared per-worktree owner. Automatic and focused probes cannot
   * race, and one fresh focused follow-up queues behind an older fleet probe.
   */
  private startWorktreeWorkingStateRefresh(params: {
    worktreePaths: string[];
    force?: boolean;
    userAction?: boolean;
  }): number {
    const worktreePaths =
      this.selectWorktreeWorkingStateRefreshCandidates(params);
    if (worktreePaths.length === 0) {
      return 0;
    }

    const registry = getDesktopBackendRegistry();
    let scheduled = 0;
    for (const worktreePath of worktreePaths) {
      if (registry.scheduleWorktreeGitWorkingStateRefresh({
        worktreePath,
        ...(params.userAction ? { userAction: true } : {}),
        acceptedPushedCommitShas:
          this.getPublishedPrCommitShasForWorktree(worktreePath),
      })) {
        scheduled += 1;
      }
    }
    return scheduled;
  }

  async refreshThreadGitWorkingState(
    request: RefreshThreadGitWorkingStateRequest,
  ): Promise<RefreshThreadGitWorkingStateResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      return await this.refreshRemoteThreadGitWorkingState(
        request,
        request.federationTarget,
      );
    }
    await getDesktopBackendRegistry().refreshThreadDirectoryRelationship(request);
    const threadKey = buildThreadIdentityKey(request.backend, request.threadId);
    const worktreePath = this.worktreePathByThreadKey.get(threadKey);
    if (!worktreePath) {
      return { scheduled: false };
    }

    await this.loadThreadGitWorkingStateCache();
    const force = request.trigger === "user";
    return {
      scheduled: this.startWorktreeWorkingStateRefresh({
        worktreePaths: [worktreePath],
        force,
        userAction: request.trigger === "user",
      }) > 0,
    };
  }

  /**
   * The owner's Git info store decides whether a request probes: its cache,
   * focused-refresh coalescing, and user-refresh budget all live there. The
   * viewer learns the result from the owner's forwarded
   * `navigation/threadGitWorkingState/updated`, which fires only on change.
   */
  private async refreshRemoteThreadGitWorkingState(
    request: RefreshThreadGitWorkingStateRequest,
    federationTarget: FederationRemoteTarget,
  ): Promise<RefreshThreadGitWorkingStateResponse> {
    const federationRuntime = getDesktopFederationRuntime();
    // Capabilities can survive a disconnect in remembered peer metadata.
    // Hover and scheduled refreshes stay silent until the owner reconnects.
    const connected = federationRuntime.connectedPeerTargets().some(
      (peer) => peer.target.instanceId === federationTarget.instanceId,
    );
    if (
      !connected
      || !federationRuntime.remoteTargetSupportsCapability(
        federationTarget,
        "thread_navigation",
      )
    ) {
      return { scheduled: false };
    }
    try {
      return await federationRuntime
        .remoteBackend(federationTarget)
        .refreshThreadGitWorkingState({
          backend: request.backend,
          threadId: request.threadId,
          trigger: request.trigger,
        });
    } catch (error) {
      // The route can disappear after the connected-peer check, and an owner
      // from before this method cannot take it.
      if (
        isFederationPeerUnavailableError(error)
        || isFederationMethodNotFoundError(error)
      ) {
        return { scheduled: false };
      }
      throw error;
    }
  }

  /**
   * Focused and user-triggered lanes name one worktree and want it now. The
   * registry owns automatic fleet selection and coalescing.
   */
  private selectWorktreeWorkingStateRefreshCandidates(params: {
    worktreePaths: string[];
    force?: boolean;
  }): string[] {
    return selectStaleWorktreeWorkingStatePaths({
      cache: getDesktopBackendRegistry().getThreadGitWorkingStateCache(),
      ...(params.force ? { force: true } : {}),
      worktreePaths: params.worktreePaths,
    });
  }

  /**
   * React to turn/command-completion events by refreshing the affected
   * thread's working-state chips, so a commit/edit made by the agent updates
   * the dirty/unpushed chips without waiting for the next snapshot re-fetch.
   * Filters out our own published notifications (and the directory-status
   * sibling) to avoid a publish→listen loop.
   */
  handleAgentEventForWorkingState(event: AgentEvent): void {
    const method = event.notification.method as string;
    if (
      method !== "turn/completed" &&
      method !== "turn/failed" &&
      method !== "turn/cancelled" &&
      method !== "item/completed" &&
      method !== "thread/branch/updated"
    ) {
      return;
    }

    const params = event.notification.params as {
      branch?: string;
      threadId?: string;
      item?: { command?: string };
    };
    const threadId = params.threadId?.trim();
    if (!threadId) {
      return;
    }

    // A command item only matters here when it mutated git state; a turn
    // ending or expected-branch adoption always warrants a re-probe.
    if (method === "item/completed") {
      const command = params.item?.command;
      if (!command || !commandLooksLikeGitMutation(command)) {
        return;
      }
    }

    const threadKey = buildThreadIdentityKey(event.backend, threadId);
    if (method === "thread/branch/updated") {
      const branch = params.branch?.trim();
      const existingContexts = this.prRefreshContextByThreadKey.get(threadKey);
      if (branch && existingContexts) {
        this.prRefreshContextByThreadKey.set(
          threadKey,
          existingContexts.map((context) =>
            context.branchScoped ? context : { ...context, branch },
          ),
        );
      }
    }

    const worktreePath = this.worktreePathByThreadKey.get(threadKey);
    if (worktreePath) {
      getDesktopBackendRegistry().invalidateWorktreeWorkingState(worktreePath);
      void this.loadThreadGitWorkingStateCache().then(() => {
        this.startWorktreeWorkingStateRefresh({
          worktreePaths: [worktreePath],
          force: true,
        });
      });
    }

    if (method === "turn/completed" || method === "thread/branch/updated") {
      if (method === "turn/completed") {
        // A finished turn is real activity on this thread even when it is off
        // screen — thaw its PRs if the poller had iceboxed them.
        this.prPollingScheduler?.noteThreadInteraction([threadKey]);
      }

      // Codex can publish turn/completed before its asynchronous branch
      // adoption finishes. Refresh again from the causally newer branch event
      // so a PR created on that branch does not wait for thread selection.
      const prContexts = this.prRefreshContextByThreadKey.get(threadKey);
      if (prContexts?.length) {
        for (const prContext of prContexts) {
          void this.refreshThreadPullRequests({
            ...prContext,
            provider: "github.com",
            trigger: "post-turn",
          }).catch((error) => {
            appServerLog.warn("turn-boundary PR refresh failed", {
              method,
              threadId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    }
  }

  handleAgentEventForPrAttachments(event: AgentEvent): void {
    if (event.federationTarget && isRemoteFederationTarget(event.federationTarget)) return;
    if (event.notification.method === "thread/archived") {
      this.setThreadPrAttachment(buildThreadIdentityKey(event.backend, event.notification.params.threadId), undefined);
    }
    if (["navigation/providerThreads/refreshed", "thread/started", "thread/archived", "thread/unarchived",
      "navigation/threadDirectories/updated", "navigation/directory/removed", "thread/parent/set", "thread/parent/cleared",
      "thread/branch/updated"].includes(event.notification.method)) {
      if (this.ownerNavigationActive) void this.refreshOwnerNavigationMetadata().catch((error) => {
        appServerLog.warn("failed to refresh owner navigation metadata", { error: String(error) });
      });
      return;
    }
    if (event.notification.method !== "thread/pullRequests/updated") return;
    this.ownerNavigationMetadataVersion += 1;
    const params = event.notification.params as {
      threadId: string;
      prs: PrSummary[];
    };
    void this.rememberThreadPrAttachmentUpdate({
      backend: event.backend,
      threadId: params.threadId,
      prs: params.prs,
    }).catch((error) => {
      appServerLog.warn("failed to reconcile PR automation candidates", {
        backend: event.backend,
        threadId: params.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async startOwnerNavigation(): Promise<void> {
    this.ownerNavigationActive = true;
    this.installCiDeploymentReviewer();
    // Continue After waits while a quiet restart's continuations go first.
    this.unsubscribeRestartGate ??= getDesktopBackendRegistry().onRestartGateChanged?.((closed) => {
      if (!closed && this.ownerNavigationActive) {
        void this.reconcileThreadDependencies().catch((error: unknown) => {
          appServerLog.warn("dependency reconcile after restart gate failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    });
    // Gates read Forge Automation from memory; load it before polling starts.
    await this.hydrateProjectForgeAutomation();
    this.syncPrPollingSchedulerState();
    const state = getDesktopBackendRegistry().getStartupProviderRefreshStatus()?.state;
    if (state === "ready" || state === "degraded") {
      await this.refreshOwnerNavigationMetadata();
    }
  }

  private async hydrateProjectForgeAutomation(): Promise<void> {
    const index = getProjectForgeAutomationIndex();
    if (index.isHydrated()) return;
    try {
      index.hydrate(await this.getOverlayStore().readAllDirectoryOverlays());
    } catch (error) {
      appServerLog.warn("failed to load project Forge Automation", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private refreshOwnerNavigationMetadata(): Promise<void> {
    this.ownerNavigationMetadataVersion += 1;
    if (this.ownerNavigationMetadataRead) {
      return this.ownerNavigationMetadataAbort?.signal.aborted
        ? this.ownerNavigationMetadataRead.then(() => this.ownerNavigationActive ? this.refreshOwnerNavigationMetadata() : undefined)
        : this.ownerNavigationMetadataRead;
    }
    const abort = new AbortController();
    this.ownerNavigationMetadataAbort = abort;
    const read = (async () => {
      // Registry event dispatch is synchronous. Let the shared index's
      // listener fence the old snapshot before this consumer joins a read.
      await Promise.resolve();
      while (this.ownerNavigationActive) {
        const version = this.ownerNavigationMetadataVersion;
        const isCurrent = () => this.ownerNavigationActive && this.ownerNavigationMetadataVersion === version;
        const index = await loadLocalNavigationQueryIndex({ backend: "all", callerReason: "owner-navigation-metadata",
          useSavedStartupInventory: true, signal: abort.signal });
        if (!this.ownerNavigationActive) return;
        if (!isCurrent()) continue;
        if (index.coverage?.state === "checking") return;
        if (!index.coverage || index.coverage.state === "complete") {
          this.getOverlayStore().initializeNavigationUnreadBaseline(index.threads);
        }
        await Promise.all([this.loadPrStatusRegistry(), this.threadPullRequestLookup.loadPrLookupRegistry()]);
        if (!isCurrent()) continue;
        // Polls address stored attachments by forge repository and number.
        // Branch and default-ref validation belongs to demand-driven reads.
        this.seedPrStatusRegistryFromThreads(index.threads);
        const canonical = this.applyCanonicalPrStatuses(index.threads);
        const complete = !index.coverage || index.coverage.state === "complete";
        await this.rememberThreadPrAttachments(canonical.threads, {
          replace: complete, isCurrent, inventoryDemand: { signal: abort.signal, priority: () => PR_METADATA_PRIORITY.background },
        });
        if (!isCurrent()) continue;
        const ownerThreads = this.applyPrimaryGitRepositories(canonical.threads);
        this.rememberPublishedPrimaryGitRepositories(ownerThreads, { replace: complete });
        await Promise.all([this.directoryGitStatus.loadDirectoryGitStatusCache(), this.loadThreadGitWorkingStateCache()]);
        if (!isCurrent()) continue;
        for (const directory of index.directories) this.lastDirectoriesByKey.set(directory.key, directory);
        this.directoryGitStatus.startDirectoryGitStatusRefresh({ automatic: true, directories: index.directories, requestKey: "owner-navigation-metadata" });
        this.rememberThreadWorktreePaths(ownerThreads);
        this.rememberThreadPrRefreshContexts(ownerThreads);
        for (const thread of ownerThreads) {
          const seenAt = thread.inbox.lastSeenAt;
          if (seenAt) {
            const key = buildThreadIdentityKey(thread.source, thread.id);
            this.prDiscoveryAccessByThreadKey.set(key, Math.max(seenAt, this.prDiscoveryAccessByThreadKey.get(key) ?? 0));
          }
        }
        const detachedPrs = await this.readDetachedPrsByThreadKey(ownerThreads);
        if (!isCurrent()) continue;
        this.rememberPublishedPrCommitShas(ownerThreads, detachedPrs);
        this.syncPrPollingSchedulerState();
        void getDesktopBackendRegistry().refreshThreadGitWorkingStates(ownerThreads).catch((error: unknown) => {
          appServerLog.warn("owner worktree status refresh failed", { error: String(error) });
        });
        if (complete) {
          const live = new Set(canonical.threads.map((thread) => buildThreadIdentityKey(thread.source, thread.id)));
          for (const map of [this.prRefreshContextByThreadKey, this.worktreePathByThreadKey, this.publishedPrCommitsByThread, this.prDiscoveryAccessByThreadKey]) {
            for (const key of map.keys()) if (!live.has(key)) map.delete(key);
          }
          const liveDirectories = new Set(index.directories.map((directory) => directory.key));
          for (const key of this.lastDirectoriesByKey.keys()) if (!liveDirectories.has(key)) this.lastDirectoriesByKey.delete(key);
        }
        await this.getPrAutoDispatchCoordinator().resume();
        if (isCurrent()) return;
      }
    })().catch((error: unknown) => { if (!abort.signal.aborted) throw error; }).finally(() => {
      if (this.ownerNavigationMetadataRead === read) this.ownerNavigationMetadataRead = undefined;
    });
    this.ownerNavigationMetadataRead = read;
    return read;
  }

  async markThreadSeen(
    request: MarkThreadSeenRequest,
  ): Promise<MarkThreadSeenResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .markThreadSeen(remoteRequest);
    }
    const backend = request.backend ?? "codex";
    const response = await markLocalThreadSeen({
      backend,
      seenAt: request.seenAt,
      seenUpdatedAt: request.seenUpdatedAt,
      threadId: request.threadId,
    });
    const threadKey = buildThreadIdentityKey(backend, request.threadId);
    this.prDiscoveryAccessByThreadKey.set(threadKey, Math.max(response.seenAt, this.prDiscoveryAccessByThreadKey.get(threadKey) ?? 0));
    // Opening a thread is the restore point when restore_on = "open". Fired
    // from this once-per-open signal, never from repeated detail reads.
    void getDesktopBackendRegistry().wakeHibernatedCheckoutOnOpen({ backend, threadId: request.threadId })
      .catch((error: unknown) => logDebug("hibernated checkout restore on open failed", {
        backend, threadId: request.threadId, error: error instanceof Error ? error.message : String(error),
      }));

    logDebug("markThreadSeen", {
      backend,
      threadId: request.threadId,
      seenUpdatedAt: request.seenUpdatedAt ?? null,
    });
    return response;
  }

  refreshThreadPullRequests(request: RefreshThreadPullRequestsRequest): Promise<RefreshThreadPullRequestsResponse> {
    return this.threadPullRequestLookup.refreshThreadPullRequests(request);
  }

  async refreshOwnedThreadPullRequests(
    request: RefreshOwnedThreadPullRequestsRequest,
  ): Promise<RefreshThreadPullRequestsResponse> {
    const backend = request.backend ?? "codex";
    const threadKey = buildThreadIdentityKey(backend, request.threadId);
    const [firstContext, ...remainingContexts] =
      this.prRefreshContextByThreadKey.get(threadKey) ?? [];
    if (!firstContext) {
      throw new Error(
        `No owner PR refresh context is available for ${threadKey}.`,
      );
    }
    const refreshContext = async (
      context: ThreadPrRefreshContext,
    ): Promise<RefreshThreadPullRequestsResponse> => {
      const { branchScoped: _branchScoped, ...lookupRequest } = context;
      return await this.refreshThreadPullRequests({
        ...lookupRequest,
        ...(request.provider ? { provider: request.provider } : {}),
        ...(request.trigger ? { trigger: request.trigger } : {}),
      });
    };

    let response = await refreshContext(firstContext);
    for (const context of remainingContexts) {
      response = await refreshContext(context);
    }
    return response;
  }

  private forgeCiClient?: ForgeCiClient;
  private githubPrToolClient?: GithubPrToolClient;
  private gitlabPrToolClient?: GitlabPrToolClient;

  getForgeCiClient(): ForgeCiClient {
    this.forgeCiClient ??= new ForgeCiClient({
      gitlab: this.getPrFetcher().gitlab,
      enabled: (provider) => getDesktopSettingsService().isForgeEnabled(provider),
      takeToken: (source) => {
        if (source === "merge_offer") return this.takePrPollingToken("Review offer stack check", [], [], 4);
        return this.takePrPollingToken(source === "operator_merge_preflight" ? "Operator merge preflight" : "Agent CI read");
      },
    });
    return this.forgeCiClient;
  }

  /** The repositories, PRs and branch a forge tool may act on for one local thread. */
  private async resolveForgeThreadScope(backend: string, threadId: string) {
    if (!isAppServerBackendKind(backend)) throw new ForgeReadError("invalid_arguments", "Unknown PwrAgent backend.");
    const active = await this.listThreads({ backend });
    const thread = active.threads.find((t) => t.id === threadId)
      ?? (await this.listThreads({ backend, archived: true })).threads.find((t) => t.id === threadId);
    if (!thread) throw new ForgeReadError("thread_not_found", "Thread is not owned by this instance.");
    const overlay = await this.getOverlayStore().getThreadOverlayState({ backend, threadId });
    const directories = resolveThreadPullRequestDirectoryPaths({ linkedDirectories: [...(thread.linkedDirectories ?? []), ...(overlay?.extraLinkedDirectories ?? [])] });
    if (directories.length > 20) throw new ForgeReadError("scope_too_large", "Forge reads support up to 20 linked directories per thread.");
    const remotes = (await Promise.all(directories.map((cwd) => readForgeRepositoryRemotes(cwd)))).flat();
    return { backend, thread, overlay, directories, remotes, attached: overlay?.prs ?? [], branch: thread.observedGitBranch ?? thread.gitBranch };
  }

  /** The calling thread's repositories, PRs, branch and directories. */
  private async forgePrToolScope(context: AgentToolCallContext): Promise<ForgePrToolScope> {
    const scope = await this.resolveForgeThreadScope(context.backend, context.threadId);
    return {
      remotes: scope.remotes, attached: scope.attached, branch: scope.branch, directories: scope.directories,
      privateRoots: getDesktopBackendRegistry().getLocalFilePrivateStorageRoots(),
    };
  }

  private knownStackPullRequests(): PrSummary[] {
    return [...this.prStatusRegistry.values()].map(({ pr }) => pr);
  }

  async stackThreadActivity(key: string): Promise<StackThreadActivity> {
    const identity = parseThreadIdentityKey(key);
    if (!identity) return {};
    const registry = getDesktopBackendRegistry();
    if (registry.stackThreadHeld?.(identity)) return { held: true };
    const pending = await this.getOverlayStore().getThreadPrAutoDispatchPending(identity);
    return {
      repair: await registry.stackRepairActive?.(identity),
      pendingRepairPrKey: pending && this.prRepositoryAliases.canonicalizeKey(pending.pending.prKey),
    };
  }

  private prStackDirectories(pr: PrSummary): string[] {
    const key = getPrStatusKey(pr);
    return [...new Set([...this.primaryPrThreadsByKey.get(key) ?? []].flatMap((threadKey) => {
      const target = parseThreadIdentityKey(threadKey);
      return target ? this.prReviewOfferDirectories(target, pr) : [];
    }))];
  }

  private createPrStackScopeReader(demand: PrMetadataDemand = {}) {
    const scopes = new Map<string, {
      catalogs: ReturnType<StackReader["preflightCatalogs"]>;
      project: () => ReturnType<StackReader["read"]>;
    }>();
    let listing: Promise<AppServerListThreadsResponse> | undefined;
    let inventory: ReturnType<DesktopAppServerService["readScopedStackInventory"]> | undefined;
    return (directories: readonly string[]) => {
      demand.signal?.throwIfAborted();
      if (!directories.length) return;
      const key = JSON.stringify(directories);
      const existing = scopes.get(key);
      if (existing) return existing;
      const observation = new StackReadObservation(demand);
      let projection: ReturnType<StackReader["read"]> | undefined;
      const project = async () => {
        const { threads } = await (listing ??= this.listThreads({}));
        await observation.revalidateAfterListing();
        return await this.projectScopedStackInventory(
          directories, observation, inventory ??= this.readScopedStackInventory(threads),
        );
      };
      const scope = {
        catalogs: this.stackReader.preflightCatalogs(directories, observation),
        project: () => projection ??= project(),
      };
      scopes.set(key, scope);
      return scope;
    };
  }

  private async readPrStacks(pr: PrSummary, readScope = this.createPrStackScopeReader()): Promise<readonly StackSummary[]> {
    const repository = `${pr.provider}:${pr.org}/${pr.repo}`.toLowerCase();
    const matches = (stack: StackSummary) => stack.repository === repository
      && stack.layers.some((layer) => layer.pullRequest?.number === pr.number);
    const scope = readScope(this.prStackDirectories(pr));
    if (!scope) return this.publishedStacks.filter(matches);
    const catalogs = await scope.catalogs;
    if (catalogs.some(({ status }) => status === "unavailable")) throw new Error("Stack catalog evidence is unavailable.");
    const tracked = catalogs.some((read) => read.status === "ok" && read.catalog.repository.toLowerCase() === repository
      && read.catalog.stacks.some((stack) => stack.branches.some((layer) =>
        layer.pullRequest?.number === pr.number || layer.branch === pr.headRefName)));
    if (!tracked && !this.knownStackPullRequests().some((lower) => isObservedStackParent(lower, pr))) return [];
    const scoped = await scope.project();
    if (scoped.catalogs.some(({ status }) => status === "unavailable")) throw new Error("Stack catalog evidence is unavailable.");
    return scoped.stacks.filter(matches);
  }

  private async prStackHoldEvidence(
    pr: PrSummary, readScope?: ReturnType<DesktopAppServerService["createPrStackScopeReader"]>,
    observeStacks?: (stacks: readonly StackSummary[] | undefined) => void,
  ): Promise<{ reason: string; lowerKey?: string } | undefined> {
    try {
      const stacks = await this.readPrStacks(pr, readScope);
      observeStacks?.(stacks);
      for (const stack of stacks) {
        const layer = stack.layers.find((entry) => entry.pullRequest?.number === pr.number);
        const block = layer && stackDispatchBlock(layer);
        if (block) return {
          reason: describeStackAutomationBlock(block),
          ...(layer?.heldBy?.number !== undefined && {
            lowerKey: getPrStatusKey({ provider: pr.provider, org: pr.org, repo: pr.repo, number: layer.heldBy.number }),
          }),
        };
      }
    } catch (error) {
      observeStacks?.(undefined);
      appServerLog.debug("could not read stack automation gate", { pr: pr.url, error: String(error) });
      return { reason: "Held while stack settlement is unavailable" };
    }
  }

  private async prStackHold(
    pr: PrSummary, readScope?: ReturnType<DesktopAppServerService["createPrStackScopeReader"]>,
    observeStacks?: (stacks: readonly StackSummary[] | undefined) => void,
  ): Promise<string | undefined> {
    return (await this.prStackHoldEvidence(pr, readScope, observeStacks))?.reason;
  }

  async automationStackHold(
    review: Pick<ThreadReview, "backend" | "threadId" | "context">,
    setWakeFilter?: (filter: ReviewAutoFixStackWakeFilter) => void,
  ): Promise<string | undefined> {
    const reviewed = reviewContextPullRequests(review.context);
    const reviewedKeys = new Set(reviewed.map((pr) => this.prRepositoryAliases.canonicalizeKey(getPrStatusKey(pr))));
    const observed = review.context ? undefined : getDesktopBackendRegistry().getCachedThreadSummary(review);
    const branch = review.context?.gitBranch ?? observed?.observedGitBranch ?? observed?.gitBranch;
    const threadKey = buildThreadIdentityKey(review.backend, review.threadId);
    const attachment = this.attachedPrsByThreadKey.get(threadKey);
    const pathKey = (value: string) => navigationPathIdentity(value, process.platform === "win32");
    const workspacePaths = new Set<string>();
    if (!reviewedKeys.size && review.context) {
      workspacePaths.add(pathKey(review.context.workspacePath));
      if (review.context.repositoryPath) workspacePaths.add(pathKey(review.context.repositoryPath));
    }
    let threadPaths: string[] | undefined;
    const candidates = reviewedKeys.size || branch ? this.canonicalizePrs(attachment?.prs ?? []).filter((pr) => {
      if (isTerminalPullRequest(pr) || !this.matchesPrimaryRepository(pr, attachment?.primaryRepoKey)) return false;
      if (reviewedKeys.size ? !reviewedKeys.has(getPrStatusKey(pr)) : pr.headRefName !== branch) return false;
      if (!workspacePaths.size) return true;
      const paths = pr.linkedDirectoryPaths?.length ? pr.linkedDirectoryPaths
        : threadPaths ??= resolveThreadPullRequestDirectoryPaths(attachment?.workspace
          ?? getDesktopBackendRegistry().getCachedThreadSummary(review) ?? { linkedDirectories: [] });
      return paths.some((value) => workspacePaths.has(pathKey(value)));
    }) : [];
    const wakeScope = setWakeFilter && createReviewStackWakeScope(threadKey, candidates);
    if (wakeScope) setWakeFilter?.(wakeScope.matches);
    // Share one observation per checkout scope within this admission. The
    // final admission guard creates a fresh reader and rechecks live state.
    const readScope = this.createPrStackScopeReader();
    try {
      for (const pr of candidates) {
        const hold = await this.prStackHold(pr, readScope, wakeScope && ((stacks) => wakeScope.observe(pr, stacks)));
        if (hold) return hold;
      }
    } finally {
      wakeScope?.finish();
    }
  }

  private async advanceStackFromObservation(pr: PrSummary, stack: StackSummary, next: StackLayer): Promise<void> {
    if (!this.ownerNavigationActive || !this.backgroundPrPollingEnabled || isTerminalPullRequest(pr) || !pr.headSha) return;
    const key = getPrStatusKey(pr);
    if (this.stackPublishActive.has(key)) return;
    // GraphQL can briefly return the old head after a successful leased
    // push. A local needs-push projection alone must not request it again.
    if (this.stackPublishAwaitingObservation.get(key) === pr.headSha) return;
    this.stackPublishAwaitingObservation.delete(key);
    if (next.role === "layer" && next.thread) {
      const actor = parseThreadIdentityKey(next.thread.key);
      if (!actor || !projectAllowsPrWatches(this.threadForgeAutomation(actor))) return;
      const registry = getDesktopBackendRegistry();
      if (registry.isRestartGateClosed?.() || registry.stackThreadActive(actor) || await registry.isThreadLocked(actor)) return;
      const attempt = this.stackPublishAttempts.get(key);
      if (this.stackPublishActive.has(key) || (attempt && "declinedHead" in attempt && attempt.declinedHead === pr.headSha)) return;
      const parent = stack.layers[stack.layers.indexOf(next) - 1]?.pullRequest;
      const parentHead = parent && this.prStatusRegistry.get(getPrStatusKey({
        provider: pr.provider, org: pr.org, repo: pr.repo, number: parent.number,
      }))?.pr.headSha;
      const signature = JSON.stringify([stack.key, next.unsettled, pr.headSha, pr.baseRefName, parent?.lifecycleState, parentHead]);
      if (attempt && "signature" in attempt && attempt.signature === signature && (attempt.retryAfter ?? Infinity) > Date.now()) return;
      const ref = parsePullRequestReferenceUrl(pr.url);
      if (ref?.kind !== "github") return;
      const controller = new AbortController();
      this.stackPublishActive.set(key, controller);
      this.stackPublishAttempts.set(key, { signature });
      if (this.stackPublishAttempts.size > 1024) this.stackPublishAttempts.delete(this.stackPublishAttempts.keys().next().value!);
      try {
        const result = await registry.publishStackLayer({
          number: pr.number, expectedHeadSha: pr.headSha,
          repository: { provider: "github", host: ref.provider, owner: ref.org, repo: ref.repo },
        }, { ...actor, transport: "mcp", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) });
        if (result && typeof result === "object" && "pushed" in result && result.pushed === true) {
          this.stackPublishAwaitingObservation.set(key, pr.headSha);
          if (this.stackPublishAwaitingObservation.size > 1024) {
            this.stackPublishAwaitingObservation.delete(this.stackPublishAwaitingObservation.keys().next().value!);
          }
        }
      } catch (error) {
        this.stackPublishAttempts.set(key, error instanceof ForgeReadError && error.code === "declined"
          ? { declinedHead: pr.headSha }
          : { signature, retryAfter: Date.now() + 30_000 });
        this.prActivity.record({
          category: "repair", source: "Stack publishing", tone: "warning", prKeys: [key], threadKeys: [next.thread.key],
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.stackPublishActive.delete(key);
      }
      return;
    }
  }

  private stackAdvanceCandidates(prs: readonly PrSummary[]): PrSummary[] {
    const parents = prs.filter((pr) => pr.lifecycleState === "merged");
    const candidates = new Map(prs.filter((pr) => !isTerminalPullRequest(pr) && pr.headSha)
      .map((pr) => [getPrStatusKey(pr), pr]));
    if (!parents.length) return [...candidates.values()];
    for (const { pr } of this.prStatusRegistry.values()) {
      const key = getPrStatusKey(pr);
      if (candidates.has(key) || !this.primaryPrThreadsByKey.has(key) || isTerminalPullRequest(pr) || !pr.headSha) continue;
      const parent = parents.some((entry) => isObservedStackParent(entry, pr)
        || this.publishedStacks.some((stack) => stack.repository === `${pr.provider}:${pr.org}/${pr.repo}`.toLowerCase()
          && entry.provider === pr.provider && entry.org.toLowerCase() === pr.org.toLowerCase() && entry.repo.toLowerCase() === pr.repo.toLowerCase()
          && stack.layers.some((layer, index) => layer.pullRequest?.number === pr.number
            && stack.layers[index - 1]?.pullRequest?.number === entry.number)));
      if (parent) candidates.set(key, pr);
    }
    return [...candidates.values()];
  }

  private queueStackAdvance(prs: readonly PrSummary[]): void {
    if (!this.ownerNavigationActive || !this.backgroundPrPollingEnabled || !prs.length) return;
    const candidates = this.stackAdvanceCandidates(prs);
    if (!candidates.length) return;
    void this.advanceObservedStacks(candidates).catch((error) => {
      appServerLog.debug("stack publishing evaluation failed", { error: String(error) });
    });
  }

  private async advanceObservedStacks(open: readonly PrSummary[]): Promise<void> {
    const byLayer = new Map(open.map((pr) => [`${pr.provider}:${pr.org}/${pr.repo}#${pr.number}`.toLowerCase(), pr]));
    // Publication requires a checkout with a local stack catalog.
    const observation = new StackReadObservation();
    const directories = await observation.hints.markerCandidates(open.flatMap((pr) => this.prStackDirectories(pr)));
    if (!directories.length) return;
    const { stacks } = await this.readScopedStacks(directories, undefined, observation, open);
    await Promise.all(stacks.flatMap((stack) => {
      const next = !stack.inferred && nextStackAdvance(stack.layers);
      const pr = next && next.pullRequest && byLayer.get(`${stack.repository}#${next.pullRequest.number}`);
      return pr && next ? [this.advanceStackFromObservation(pr, stack, next)] : [];
    }));
  }

  private async readStackMergeEvidence(thread: PrReviewOfferThread, pr: PrSummary) {
    const ref = parsePullRequestReferenceUrl(pr.url);
    if (!ref) return { blocked: false, lowerKeys: [] };
    if (ref.kind !== "github") {
      const parents = this.knownStackPullRequests().filter((parent) => isObservedStackParent(parent, pr));
      return { blocked: parents.length > 0, lowerKeys: parents.map(getPrStatusKey) };
    }
    const repository = { provider: "github" as const, host: ref.provider, owner: ref.org, repo: ref.repo };
    const preflight = await this.stackReader.preflightCatalogs(
      this.prReviewOfferDirectories(thread, pr), new StackReadObservation(),
    );
    const catalogs = preflight.flatMap((catalog) => catalog.status === "ok" ? [catalog.catalog] : []);
    const ci = this.getForgeCiClient();
    const path = `repos/${encodeURIComponent(ref.org)}/${encodeURIComponent(ref.repo)}`;
    const lowerKeys = new Set<string>();
    const request = (params: Parameters<ForgeCiClient["requestGithubForMergeOffer"]>[1]) =>
      ci.requestGithubForMergeOffer(repository, params);
    try {
      const base = await assertGithubStackMergeAllowed(repository, pr.number, catalogs,
        (route) => request({ path: path + route }),
        async (query, variables) => (await request({
          path: "", graphql: true, body: { query, variables },
        }) as { data?: unknown }).data,
        (number) => lowerKeys.add(getPrStatusKey({ provider: pr.provider, org: pr.org, repo: pr.repo, number })),
      );
      const retryOnObservation = (pr.baseRefName !== undefined && base !== pr.baseRefName)
        || preflight.some(({ status }) => status === "unavailable");
      return { blocked: retryOnObservation, lowerKeys: [...lowerKeys], retryOnObservation };
    } catch (error) {
      if (!(error instanceof ForgeReadError) || error.code !== "stack_parent_open") {
        appServerLog.debug("stack merge evidence unavailable", { pr: pr.url, error: String(error) });
        return { blocked: true, lowerKeys: [...lowerKeys], retryOnObservation: true };
      }
      return { blocked: true, lowerKeys: [...lowerKeys] };
    }
  }

  private readScopedStackInventory(
    threads: AppServerThreadSummary[],
    scope?: { backend: string; threadId: string; prs: PrSummary[] },
  ) {
    const attached = getDesktopOverlayStore().readNavigationPullRequests(threads.map((thread) => ({
      backend: thread.source, threadId: thread.id,
    })));
    const rows = threads.map((thread, index) => {
      const attachment = this.attachedPrsByThreadKey.get(buildThreadIdentityKey(thread.source, thread.id));
      const isScope = scope && thread.source === scope.backend && thread.id === scope.threadId;
      return {
        ...thread, linkedDirectories: attachment?.workspace?.linkedDirectories ?? thread.linkedDirectories,
        prs: this.canonicalizePrs(isScope ? scope.prs : attachment?.prs ?? attached[index] ?? []),
      };
    });
    return { rows, knownPrs: this.knownStackPullRequests() };
  }

  private async readScopedStacks(
    directories: readonly string[],
    scope?: { backend: string; threadId: string; prs: PrSummary[] },
    observation = new StackReadObservation(),
    publishingPrs?: readonly PrSummary[],
  ) {
    observation.demand.signal?.throwIfAborted();
    if (!directories.length) return { stacks: [], catalogs: [] };
    const { threads } = await this.listThreads({});
    await observation.revalidateAfterListing();
    return await this.projectScopedStackInventory(
      directories, observation, this.readScopedStackInventory(threads, scope), publishingPrs,
    );
  }

  private projectScopedStackInventory(
    directories: readonly string[], observation: StackReadObservation,
    inventory: ReturnType<DesktopAppServerService["readScopedStackInventory"]>,
    publishingPrs?: readonly PrSummary[],
  ) {
    const { rows, knownPrs } = inventory;
    return this.stackReader.read(rows, knownPrs, directories,
      (key) => this.stackThreadActivity(key), observation, undefined, publishingPrs);
  }

  private forgePrToolService(context?: AgentToolCallContext): ForgePrToolService {
    this.githubPrToolClient ??= new GithubPrToolClient({ ci: this.getForgeCiClient() });
    this.gitlabPrToolClient ??= new GitlabPrToolClient({ gitlab: this.getPrFetcher().gitlab });
    return new ForgePrToolService({
      enabled: (provider) => getDesktopSettingsService().isForgeEnabled(provider),
      clients: { github: this.githubPrToolClient, gitlab: this.gitlabPrToolClient },
      defaultMergeMethod: () => getDesktopSettingsService().resolveDefaultMergeMethod(),
      assertCanMerge: (repository, number) => {
        const marker = repository.provider === "gitlab" ? "-/merge_requests" : "pull";
        try {
          const overlay = getDesktopOverlayStore();
          assertMergeNotHeld(createThreadDependencyStorage().active(), {
            backend: context?.backend ?? "", threadId: context?.threadId ?? "",
            pullRequest: `https://${repository.host}/${repository.owner}/${repository.repo}/${marker}/${number}`,
          }, (thread) => overlay.readThreadPullRequestUrls(thread));
        } catch (error) {
          throw new ForgeReadError("merge_held", error instanceof Error ? error.message : String(error));
        }
      },
    });
  }

  /**
   * A merge from a thread whose project never merges is refused before any
   * forge call, unless the PR's base, as this owner last read it, is one the
   * project still merges into.
   */
  private assertProjectMerges(
    context: AgentToolCallContext,
    args: ForgePrToolArgs,
    scope: Awaited<ReturnType<DesktopAppServerService["forgePrToolScope"]>>,
  ): void {
    if (!isAppServerBackendKind(context.backend)) return;
    const ref = { backend: context.backend, threadId: context.threadId };
    const project = this.resolveThreadForgeProject(ref);
    if (!project || !projectNeverMerges(project.automation)) return;
    const number = typeof args.number === "number" ? args.number : undefined;
    const refusal = this.projectNeverMergeRefusal(ref, number === undefined ? undefined : {
      number,
      baseRefName: this.forgePrToolBaseRef(args, scope, number),
    });
    if (refusal) throw new ForgeReadError("forbidden", refusal);
  }

  /** The base this owner last read for the PR a merge call names; undefined when unknown. */
  private forgePrToolBaseRef(
    args: ForgePrToolArgs,
    scope: Awaited<ReturnType<DesktopAppServerService["forgePrToolScope"]>>,
    number: number,
  ): string | undefined {
    try {
      const repository = this.forgePrToolService().resolveRepository(args, scope);
      return this.prStatusRegistry.get(getPrStatusKey({
        provider: repository.host, org: repository.owner, repo: repository.repo, number,
      }))?.pr?.baseRefName;
    } catch {
      // The merge itself reports an unresolvable repository; here it is unknown.
      return undefined;
    }
  }

  /**
   * The base branch this owner last read for one of a thread's PRs, named
   * by URL or number; undefined when it has read none.
   */
  readThreadPullRequestBaseRef(
    thread: { backend: AppServerBackendKind; threadId: string },
    pullRequest: string,
  ): string | undefined {
    const attached = this.findPrimaryAttachedPr(thread, pullRequest);
    if (attached) return (this.prStatusRegistry.get(getPrStatusKey(attached))?.pr ?? attached).baseRefName;
    const ref = parsePullRequestReferenceUrl(pullRequest);
    return ref
      ? this.prStatusRegistry.get(getPrStatusKey({ provider: ref.provider, org: ref.org, repo: ref.repo, number: ref.number }))?.pr?.baseRefName
      : undefined;
  }

  /** The repository and settled arguments of a call, so an approval prompt names them and a bad call fails first. */
  async prepareForgePrToolForAgent(operation: ForgePrToolOperation, args: ForgePrToolArgs, context: AgentToolCallContext): Promise<ForgePrToolPreflightResult> {
    const scope = await this.forgePrToolScope(context);
    if (operation === "publish_stack_layer") {
      const prepared = await this.forgePrToolService().prepare(operation, args, scope, context.signal);
      const { repository } = prepared;
      if (repository.provider !== "github") throw new ForgeReadError("unsupported_provider", "Stack publishing requires GitHub.");
      const pr = this.stackPublishAttachment(args, scope, repository);
      if (args.expectedHeadSha) return prepared;
      const head = await readStackPublishHead(repository, pr.number,
        (...params) => this.getForgeCiClient().requestGithub(...params), context.signal);
      return { ...prepared, args: { ...prepared.args, expectedHeadSha: head } };
    }
    if (operation !== "merge_pull_request") {
      return await this.forgePrToolService().prepare(operation, args, scope, context.signal);
    }
    this.assertProjectMerges(context, args, scope);
    // A merge reads and keeps the project's merge-method pick, the one a
    // to-do merge card for this project would use.
    const preference = await readProjectMergeMethodPreference(getDesktopBackendRegistry(), context);
    const prepared = await this.forgePrToolService().prepare(operation, args, scope, context.signal, {
      rememberedMergeMethod: preference.remembered,
    });
    if (!prepared.mergeMethods || !preference.remember) return prepared;
    return { ...prepared, mergeMethods: { ...prepared.mergeMethods, remember: preference.remember } };
  }

  private stackPublishAttachment(args: ForgePrToolArgs, scope: Awaited<ReturnType<DesktopAppServerService["forgePrToolScope"]>>, repository: ForgeRepository) {
    const pr = this.canonicalizePrs(scope.attached).find((entry) =>
      entry.number === args.number && !isTerminalPullRequest(entry)
      && `${entry.provider}:${entry.org}/${entry.repo}`.toLowerCase() === githubStackRepository(repository));
    if (!pr) throw new ForgeReadError("not_found", "Select a live PR attached to this layer thread.");
    return pr;
  }

  private async publishStackLayer(args: ForgePrToolArgs, context: AgentToolCallContext,
    scope: Awaited<ReturnType<DesktopAppServerService["forgePrToolScope"]>>) {
    const repository = this.forgePrToolService().resolveRepository(args, scope);
    if (repository.provider !== "github") throw new ForgeReadError("unsupported_provider", "Stack publishing requires GitHub.");
    const pr = this.stackPublishAttachment(args, scope, repository);
    if (!args.expectedHeadSha) throw new ForgeReadError("invalid_arguments", "Stack publishing requires a verified PR head.");
    const readGate = async () => {
      const live = this.prStatusRegistry.get(getPrStatusKey(pr))?.pr ?? pr;
      if (isTerminalPullRequest(live)) throw new ForgeReadError("stale_plan", "The PR closed before publishing.");
      if (!context.turnId && (!this.ownerNavigationActive || !projectAllowsPrWatches(this.threadForgeAutomation(context)))) {
        throw new ForgeReadError("tools_disabled", "Project automation is paused.");
      }
      const stacks = (await this.readPrStacks(live, this.createPrStackScopeReader({
        signal: context.signal,
        priority: () => context.turnId ? PR_METADATA_PRIORITY.selected : PR_METADATA_PRIORITY.background,
      }))).filter((stack) => !stack.inferred);
      const stack = stacks.length === 1 ? stacks[0] : undefined;
      const layer = stack?.layers.find((entry) => entry.pullRequest?.number === pr.number);
      if (!stack || !layer || layer.role !== "layer" || layer.thread?.key !== buildThreadIdentityKey(context.backend, context.threadId)) {
        throw new ForgeReadError("ambiguous_layer", "The PR needs one tracked stack and one local layer owner.");
      }
      if (layer.heldBy) throw new ForgeReadError("stack_parent_open", describeStackAutomationBlock(layer.heldBy));
      if (layer.health === "drift" || layer.health === "remote_ahead") {
        throw new ForgeReadError("stale_plan", "The PR base or remote branch changed.");
      }
      return { stack, layer };
    };
    const ci = this.getForgeCiClient();
    return await this.stackOperations.publish({
      actor: { backend: context.backend, threadId: context.threadId }, number: pr.number, repository, directories: scope.directories,
      expectedHead: args.expectedHeadSha, signal: context.signal, automated: !context.turnId,
      readGate, github: (...parameters) => ci.requestGithub(...parameters),
    }, getDesktopBackendRegistry());
  }

  /** Pull request and issue tools act only in the calling thread's own repositories. */
  async runForgePrToolForAgent(operation: ForgePrToolOperation, args: ForgePrToolArgs, context: AgentToolCallContext): Promise<unknown> {
    const scope = await this.forgePrToolScope(context);
    if (operation === "merge_pull_request") this.assertProjectMerges(context, args, scope);
    const stackDemand = { signal: context.signal, priority: () => PR_METADATA_PRIORITY.selected };
    if (operation === "publish_stack_layer") return await this.publishStackLayer(args, context, scope);
    if (operation === "plan_stack_operation" || operation === "apply_stack_operation" || operation === "manage_stack_operation") {
      if (!isAppServerBackendKind(context.backend)) throw new ForgeReadError("invalid_arguments", "Unknown PwrAgent backend.");
      const repository = this.forgePrToolService().resolveRepository(args, scope);
      if (repository.provider !== "github") throw new ForgeReadError("unsupported_provider", "Stack operations use the gh stack catalog for GitHub repositories.");
      const actor = { backend: context.backend, threadId: context.threadId };
      try {
        return await this.stackOperations.call(operation, args, actor, {
          directories: scope.directories, repository: githubStackRepository(repository), branch: scope.branch,
          ...(args.operation === "sync" ? {
            sync: { repository, github: (...parameters) => this.getForgeCiClient().requestGithub(...parameters), signal: context.signal },
          } : {}),
          infer: async () => (await this.readScopedStacks(
            scope.directories, { ...actor, prs: this.canonicalizePrs(scope.attached) }, new StackReadObservation(stackDemand),
          )).stacks,
        }, getDesktopBackendRegistry());
      } catch (error) {
        if (error instanceof StackOperationError) throw new ForgeReadError(error.code, error.message);
        throw error;
      }
    }
    if (operation === "list_stacks") {
      const repository = args.repository && this.forgePrToolService().resolveRepository(args, scope);
      const { stacks, catalogs } = await this.readScopedStacks(scope.directories, {
        backend: context.backend, threadId: context.threadId, prs: this.canonicalizePrs(scope.attached),
      }, new StackReadObservation(stackDemand));
      return {
        stacks: repository ? stacks.filter((stack) => stack.repository === githubStackRepository(repository)) : stacks,
        catalogIssues: catalogs.flatMap((catalog) => ["ok", "missing"].includes(catalog.status) ? [] : [catalog]),
        backend: context.backend, threadId: context.threadId,
      };
    }
    const result = await this.forgePrToolService(context).execute(operation, args, scope, context.signal);
    if (operation === "rerun_failed_ci_jobs") {
      // The re-run already happened; failing to remember it must not fail the call.
      await this.recordCiRerun(result, context).catch((error: unknown) => {
        appServerLog.warn("failed to record a CI re-run", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return { ...(result as Record<string, unknown>), backend: context.backend, threadId: context.threadId };
  }

  /**
   * A re-run keeps the head, so the cached failure it replaces still looks
   * current. Record it for the calling thread's open PRs at that head, then
   * refresh those PRs once through the shared poll budget.
   */
  private async recordCiRerun(result: unknown, context: AgentToolCallContext): Promise<void> {
    const rerun = result as {
      requested?: unknown;
      runId?: unknown;
      runAttempt?: unknown;
      headSha?: unknown;
      repository?: { host?: unknown; owner?: unknown; repo?: unknown };
    } | undefined;
    if (rerun?.requested !== true || typeof rerun.runId !== "number") return;
    const repository = rerun.repository;
    const fold = (value: unknown) => typeof value === "string" ? value.toLowerCase() : undefined;
    const headSha = typeof rerun.headSha === "string" && rerun.headSha.trim()
      ? rerun.headSha.trim()
      : undefined;
    const requestedAt = Date.now();
    // Read the overlay, as the watch tool does: a thread no navigation
    // refresh has listed yet has no in-memory attachment.
    const { prs: attachedPrs } = await this.readPrimaryAttachedPrs({
      backend: context.backend,
      threadId: context.threadId,
    });
    const prKeys = new Set<string>();
    for (const attached of attachedPrs) {
      const prKey = getPrStatusKey(attached);
      const pr = this.prStatusRegistry.get(prKey)?.pr ?? attached;
      if (isTerminalPullRequest(pr)) continue;
      const prRepository = repositoryFromPr(pr.url);
      if (
        !prRepository
        || fold(prRepository.host) !== fold(repository?.host)
        || fold(prRepository.owner) !== fold(repository?.owner)
        || fold(prRepository.repo) !== fold(repository?.repo)
      ) {
        continue;
      }
      if (headSha && pr.headSha && pr.headSha.trim() !== headSha) continue;
      prKeys.add(prKey);
    }
    for (const [prKey, entry] of this.ciRerunsByPrKey) {
      if (requestedAt - entry.requestedAt > RERUN_RECORD_MAX_AGE_MS) this.ciRerunsByPrKey.delete(prKey);
    }
    for (const prKey of prKeys) {
      this.ciRerunsByPrKey.set(prKey, {
        ...(headSha ? { headSha } : {}),
        runId: rerun.runId,
        ...(typeof rerun.runAttempt === "number" ? { runAttempt: rerun.runAttempt } : {}),
        requestedAt,
      });
    }
    this.requestPriorityPrRefresh(prKeys);
  }

  /** Poll these PRs on the next pass whatever their cadence, within the shared token budget. */
  private requestPriorityPrRefresh(prKeys: ReadonlySet<string>): void {
    const scheduler = this.prPollingScheduler;
    if (!scheduler || prKeys.size === 0 || !this.backgroundPrPollingEnabled) return;
    const targets = this.collectPrPollTargets()
      .filter((target) => prKeys.has(target.prKey))
      .map(({ fetchedAt: _fetchedAt, ...target }) => target);
    if (targets.length === 0) return;
    for (const target of targets) scheduler.forgetTarget(target.prKey);
    void scheduler.tick(() => targets);
  }

  async readForgeForTool(operation: ForgeReadOperation, args: ForgeReadArgs, context: AgentToolCallContext): Promise<unknown> {
    const { backend, thread, overlay, directories, remotes, attached } = await this.resolveForgeThreadScope(args.backend ?? context.backend, args.threadId ?? context.threadId);
    const threadId = thread.id;
    // Snapshot reads must not call rememberPrStatuses: it publishes transitions.
    const observations = new Map<string, { pr: PrSummary; fetchedAt: number }>();
    const persisted = this.prStatusRegistryLoaded ? [] : Object.values(await this.getOverlayStore().readPrStatusCache());
    for (const entry of [...attached.map((pr) => ({ pr, fetchedAt: overlay?.prsFetchedAt ?? 0 })), ...persisted, ...this.prStatusRegistry.values()]) {
      const key = getPrStatusKey(entry.pr);
      if (!observations.has(key) || observations.get(key)!.fetchedAt < entry.fetchedAt) observations.set(key, { pr: entry.pr, fetchedAt: entry.fetchedAt });
    }
    const enabled = (provider: "github" | "gitlab") => getDesktopSettingsService().isForgeEnabled(provider);
    const service = new ForgeReadService({
      enabled, ci: this.getForgeCiClient(),
      refresh: async (request, repositories) => {
        context.signal?.throwIfAborted();
        const urls = request.url ? [request.url] : attached.filter((pr) => {
          const r = repositoryFromPr(pr.url);
          return r && repositories.some((selected) => selected.provider === r.provider && selected.host === r.host && selected.owner === r.owner && selected.repo === r.repo)
            && (!request.branch || pr.headRefName === request.branch);
        }).map((pr) => pr.url);
        if (urls.length > 20) throw new ForgeReadError("scope_too_large", "Select a PR/MR URL or branch to refresh at most 20 requests.");
        const fetcher = this.getPrFetcher();
        const availability = await fetcher.getProviderAvailability(directories, urls);
        if (repositories.some((r) => !availability.some((a) => a.provider === r.host && a.available))) throw new ForgeReadError("unavailable", "A selected forge provider is unavailable. Check its CLI installation and host login in Settings → Git.");
        let failed = false;
        const results: PrSummary[] = [];
        if (urls.length) {
          for (const url of urls) {
            context.signal?.throwIfAborted();
            if (!this.takePrPollingToken("Agent explicit forge refresh")) throw new ForgeReadError("rate_limited", "The shared PR refresh budget is exhausted.");
            const pr = await fetcher.fetchPullRequestByUrl({ cwd: directories[0] ?? os.homedir(), url, onProviderFailure: () => { failed = true; } });
            this.learnPullRequestRepository(url, pr);
            if (!pr) failed = true;
            else results.push(pr);
          }
        } else {
          for (const cwd of directories) {
            context.signal?.throwIfAborted();
            if (!this.takePrPollingToken("Agent branch forge refresh")) throw new ForgeReadError("rate_limited", "The shared PR refresh budget is exhausted.");
            results.push(...await fetcher.fetchAllPullRequestsForBranch({ allowPrimed: false, providers: [...new Set(repositories.map((r) => r.provider))], cwd, branch: request.branch ?? thread.observedGitBranch ?? thread.gitBranch ?? "HEAD", onProviderFailure: () => { failed = true; } }));
          }
        }
        if (failed) throw new ForgeReadError("provider_error", "PR/MR refresh failed or was unavailable. Check the host's CLI login, read permissions and provider settings. Cached observations were not changed.");
        return results;
      },
    });
    const result = await service.execute(operation, args, {
      remotes,
      attached,
      observations: [...observations.values()],
      branch: thread.observedGitBranch ?? thread.gitBranch,
      artifactDirectory: threadArtifactDirectory({ backend, threadId }),
    }, context.signal);
    const prAutomation = await this.getThreadPullRequestAutomationStatus({ backend, threadId }, { backend: context.backend, threadId: context.threadId });
    return { ...(result as Record<string, unknown>), backend, threadId, prAutomation };
  }

  async checkThreadPullRequestStatusForTool(
    args: CheckThreadPullRequestStatusToolArgs,
    context?: PwrAgentThreadInspectionContext,
  ): Promise<PwrAgentThreadInspectionResponse> {
    if (!args.backend || !isAppServerBackendKind(args.backend)) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "backend must be a known PwrAgent backend.",
        },
      };
    }
    const threadId = args.threadId?.trim();
    if (!threadId) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "threadId is required.",
        },
      };
    }

    const activeThreads = await this.listThreads({ backend: args.backend });
    let thread = activeThreads.threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      const archivedThreads = await this.listThreads({
        backend: args.backend,
        archived: true,
      });
      thread = archivedThreads.threads.find((candidate) => candidate.id === threadId);
    }
    if (!thread) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `Thread ${args.backend}:${threadId} was not found.`,
        },
      };
    }

    const overlay = await this.getOverlayStore().getThreadOverlayState({
      backend: args.backend,
      threadId,
    });
    const branch = args.branch?.trim()
      || thread.observedGitBranch?.trim()
      || thread.gitBranch?.trim()
      || "HEAD";
    const directoryPaths = normalizePrLookupDirectoryPaths(
      args.directoryPaths?.length
        ? args.directoryPaths
        : resolveThreadPullRequestDirectoryPaths({
            linkedDirectories: [
              ...(thread.linkedDirectories ?? []),
              ...(overlay?.extraLinkedDirectories ?? []),
            ],
          }),
    );
    const lookupDirectoryPaths = directoryPaths.length > 0
      ? directoryPaths
      : (overlay?.prs?.length ? [os.homedir()] : []);
    const requestedAt = Date.now();
    const response = await this.refreshThreadPullRequests({
      backend: args.backend,
      threadId,
      provider: args.provider,
      trigger: "user",
      branch,
      directoryPaths: lookupDirectoryPaths,
      includeStatusFreshness: true,
    });
    const prAutomation = await this.getThreadPullRequestAutomationStatus(
      {
        backend: args.backend,
        threadId,
      },
      context,
    );

    return {
      ok: true,
      data: {
        pullRequestStatus: {
          ...response,
          requestedAt,
          branch,
          directoryPaths: lookupDirectoryPaths,
          prAutomation,
        },
      },
    };
  }

  async watchThreadPullRequestForTool(
    args: WatchThreadPullRequestToolArgs,
    provenance?: import("@pwragent/shared/messaging-causal-context").CausalMessagingContext,
  ): Promise<PwrAgentThreadInspectionResponse> {
    const action = args.action ?? "watch";
    if (action === "list" || action === "cancel") {
      return await this.listOrCancelThreadPrWatchesForTool({ ...args, action });
    }
    if (action !== "watch") {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "action must be watch, list, or cancel.",
        },
      };
    }
    const armed = await this.armThreadPrWatch({ ...args, createdBy: "agent" }, provenance);
    return armed.ok
      ? { ok: true, data: { pullRequestWatch: armed.result } }
      : { ok: false, error: armed.error };
  }

  /** The agent's own list and cancel, scoped to one thread's waiting watches. */
  private async listOrCancelThreadPrWatchesForTool(
    args: WatchThreadPullRequestToolArgs & { action: "list" | "cancel" },
  ): Promise<PwrAgentThreadInspectionResponse> {
    const invalid = (message: string): PwrAgentThreadInspectionResponse => ({
      ok: false,
      error: { code: "invalid_arguments", message },
    });
    if (!args.backend || !isAppServerBackendKind(args.backend)) {
      return invalid("backend must be a known PwrAgent backend.");
    }
    const threadId = args.threadId?.trim();
    if (!threadId) return invalid("threadId is required.");
    const backend = args.backend;
    const store = this.getOverlayStore();
    const waiting = await store.listActiveThreadPrStatusWatches({ backend, threadId });
    const respond = (result: ThreadPullRequestWatchListResult): PwrAgentThreadInspectionResponse => ({
      ok: true,
      data: { pullRequestWatches: result },
    });
    if (args.action === "list") {
      const requestedUrl = normalizePrWatchUrl(args.url);
      const watches = requestedUrl
        ? waiting.filter((watch) => normalizePrWatchUrl(watch.prUrl) === requestedUrl)
        : waiting;
      return respond({ action: "list", watches, message: describePrWatchList(watches) });
    }
    const watchId = args.watchId?.trim();
    if (!watchId) {
      return invalid("watchId is required to cancel. Call with action list to find it.");
    }
    const target = waiting.find((watch) => watch.watchId === watchId);
    const cancelled = target
      ? await store.cancelThreadPrStatusWatch({
          backend,
          threadId,
          watchId,
          now: Date.now(),
          endedReason: "cancelled_by_agent",
        })
      : undefined;
    if (!target || !cancelled) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: target
            ? "That watch is waking the thread now, so it can no longer be cancelled."
            : "No waiting watch on this thread has that watchId. Call with action list to see them.",
        },
      };
    }
    await this.publishPrWatchesUpdated([cancelled]);
    const watches = waiting.filter((watch) => watch.watchId !== watchId);
    return respond({
      action: "cancel",
      watches,
      cancelled: target,
      message: describePrWatchCancel(target, watches),
    });
  }

  /**
   * Arms the watches `watch_thread_pull_request` and the operator's Watch CI
   * create. Both run this, so a watch means the same thing whoever asked.
   */
  private async armThreadPrWatch(
    args: WatchThreadPullRequestToolArgs & { createdBy: "agent" | "operator" },
    provenance?: import("@pwragent/shared/messaging-causal-context").CausalMessagingContext,
  ): Promise<
    | { ok: true; result: WatchThreadPullRequestResult }
    | {
        ok: false;
        error: {
          code: "invalid_arguments" | "not_found" | "forbidden" | typeof PROJECT_PAUSED_ERROR_CODE;
          message: string;
        };
      }
  > {
    if (!args.backend || !isAppServerBackendKind(args.backend)) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "backend must be a known PwrAgent backend.",
        },
      };
    }
    const threadId = args.threadId?.trim();
    if (!threadId) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "threadId is required.",
        },
      };
    }
    if (!this.backgroundPrPollingEnabled) {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message:
            "Background pull request polling is off. Enable it before asking PwrAgent to watch a PR.",
        },
      };
    }
    const project = this.resolveThreadForgeProject({ backend: args.backend, threadId });
    if (project && !projectAllowsPrWatches(project.automation)) {
      const pullRequest = args.url?.trim().match(/\/(?:pull|merge_requests)\/(\d+)/)?.[1];
      return {
        ok: false,
        error: {
          code: project.automation.paused ? PROJECT_PAUSED_ERROR_CODE : "forbidden",
          message: buildProjectPrWatchRefusal({
            projectLabel: project.label,
            ...(pullRequest ? { pullRequest: `PR #${pullRequest}` } : {}),
            paused: project.automation.paused,
          }),
        },
      };
    }
    const requestedEvents = normalizePrStatusWatchEvents(args.notifyOn);
    if (!requestedEvents) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "notifyOn must contain one or more of success, failure, merged, and closed.",
        },
      };
    }

    const { overlay, prs: primaryPrs, primaryRepoKey } = await this.readPrimaryAttachedPrs({
      backend: args.backend,
      threadId,
    });
    let attachedPrs = primaryPrs;
    const matchesUrl = (url: string | undefined) => {
      const requested = normalizePrWatchUrl(url);
      return requested
        ? attachedPrs.filter((pr) => normalizePrWatchUrl(pr.url) === requested)
        : attachedPrs;
    };
    const requestedUrl = normalizePrWatchUrl(args.url);
    let matches = matchesUrl(args.url && this.prRepositoryAliases.canonicalizeUrl(args.url.trim()));
    if (requestedUrl && matches.length === 0) {
      // A renamed repository's old URL: ask the forge which PR it names.
      const cwd = attachedPrs[0]?.linkedDirectoryPaths?.[0];
      const resolved = await this.resolvePullRequestReference({
        url: args.url!.trim(),
        ...(cwd ? { cwd } : {}),
      });
      if (resolved) {
        // The answer can teach a rename, which changes both the rows and
        // which of them belong to the primary repository.
        attachedPrs = (await this.canonicalizeStoredPullRequests(overlay?.prs ?? []))
          .filter((pr) => this.matchesPrimaryRepository(pr, primaryRepoKey));
        matches = matchesUrl(resolved.url);
      }
    }
    if (matches.length !== 1) {
      const message = requestedUrl
        ? "The requested pull request is not attached to this thread's primary workspace."
        : attachedPrs.length === 0
          ? "This thread's primary workspace does not have an attached pull request to watch."
          : "url is required when a thread has more than one attached pull request.";
      return {
        ok: false,
        error: {
          code: matches.length === 0 ? "not_found" : "invalid_arguments",
          message,
        },
      };
    }

    const attachedPr = matches[0]!;
    const prKey = getPrStatusKey(attachedPr);
    const currentPrEntry = this.prStatusRegistry.get(prKey);
    const pr = currentPrEntry?.pr ?? attachedPr;
    const headSha = pr.headSha?.trim();
    const ciEvents = requestedEvents.filter((event) =>
      event === "success" || event === "failure"
    );
    const terminalEvents = requestedEvents.filter((event) =>
      event === "merged" || event === "closed"
    );
    const prAutomation = await this.getThreadPullRequestAutomationStatus({
      backend: args.backend,
      threadId,
    });
    const failureCoveredByAutoFix = prAutomation.autoFixActive
      && ciEvents.includes("failure");
    if (isTerminalPullRequest(pr)) {
      // A merged or closed PR has nothing left to watch. Report it now, with
      // the same merge details a merge/close wake would carry.
      const terminal = await this.getPrStatusWatchCoordinator()
        .resolveTerminalDetails(pr);
      const terminalOutcome = pr.lifecycleState === "merged" ? "merged" : "closed";
      const currentOutcome = terminalEvents.length > 0 || ciEvents.length === 0
        ? terminalOutcome
        : getPrStatusWatchOutcome(pr);
      return {
        ok: true,
        result: {
          ...(currentOutcome ? { currentOutcome } : {}),
          ...(terminal ? { terminal } : {}),
          coveredByAutoFix: failureCoveredByAutoFix ? ["failure"] : [],
          prAutomation,
          armed: false,
          reason: "pr_terminal",
          message: `No watch was created: PR #${pr.number} is already ${
            terminalOutcome === "merged" ? "merged" : "closed without merge"
          }.`,
        },
      };
    }
    // A terminal PR is answered above without a head; a CI watch needs one.
    if (!headSha && ciEvents.length > 0) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "The attached pull request does not have a known head SHA yet. Check its status once, then create the watch.",
        },
      };
    }
    const createdAt = Date.now();
    const currentOutcome = getPrStatusWatchOutcome(pr);
    const observedAt = currentPrEntry?.fetchedAt;
    const currentOutcomeIsFresh = observedAt !== undefined
      && createdAt - observedAt <= PR_STATUS_WATCH_CURRENT_OUTCOME_MAX_AGE_MS;
    // A re-run keeps the head, so neither the head nor the cache's age can
    // tell its result from the attempt it replaced. A status read before the
    // re-run settled is the old attempt, fresh or not.
    const recordedRerun = this.ciRerunsByPrKey.get(prKey);
    const rerun = recordedRerun && (!recordedRerun.headSha || recordedRerun.headSha === headSha)
      ? recordedRerun
      : undefined;
    const staleAfterRerun = Boolean(
      rerun && (observedAt ?? 0) <= rerun.requestedAt + RERUN_SETTLE_MS,
    );
    // Right after a push the cache can still hold the previous head's final
    // outcome, fresh or not. A checkout past that head makes it stale: the
    // watch waits at the cached head with it as the baseline, and the next
    // poll moves the watch to the pushed head.
    const pushedHeadSha = currentOutcome && ciEvents.length > 0 && headSha
      ? await this.readPushedPrHeadSha({
          backend: args.backend,
          threadId,
          pr: attachedPr,
          headSha,
          overlay,
        })
      : undefined;
    const baseline: ThreadPullRequestWatchBaseline | undefined = currentOutcome
      && ciEvents.length > 0
      && (staleAfterRerun || pushedHeadSha !== undefined || args.waitForNextResult === true)
      ? {
          outcome: currentOutcome,
          observedAt: observedAt ?? createdAt,
          ...(currentOutcome === "failure" && pr.failedCheckUrl
            ? { failedCheckUrl: pr.failedCheckUrl }
            : {}),
          ...(rerun ? { rerunRequestedAt: rerun.requestedAt } : {}),
          ...(rerun?.runAttempt !== undefined ? { runAttempt: rerun.runAttempt } : {}),
        }
      : undefined;
    const ciOutcomeAlreadyKnown = Boolean(
      currentOutcome
      && ciEvents.includes(currentOutcome)
      && currentOutcomeIsFresh
      && !baseline,
    );
    // Auto-fix dedupes a repeat failure at the same head, so it will not wake
    // the thread for a failure that follows a baseline failure there. A
    // pushed head is a new head, where Auto-fix sees any failure.
    const coversFailure = (watchBaseline: ThreadPullRequestWatchBaseline | undefined) =>
      failureCoveredByAutoFix
      && (pushedHeadSha !== undefined || watchBaseline?.outcome !== "failure");
    // The re-run's attempt is what this watch waits for while its result is
    // not known yet. Kept beside the baseline, which clears once checks run.
    const watchRun = rerun && pushedHeadSha === undefined && (staleAfterRerun || !currentOutcome)
      ? {
          ...(rerun.runAttempt !== undefined ? { runAttempt: rerun.runAttempt } : {}),
          runId: rerun.runId,
        }
      : {};
    const baseWatch = {
      backend: args.backend,
      threadId,
      prKey,
      prUrl: pr.url,
      prNumber: pr.number,
      ...(pr.title ? { prTitle: pr.title } : {}),
      createdAt,
      createdBy: args.createdBy,
      ...(provenance?.causalMessagingSource ? { causalMessagingSource: provenance.causalMessagingSource } : {}),
      ...(provenance?.causalMessagingAmbiguous ? { causalMessagingAmbiguous: true } : {}),
    };
    let watch: ThreadPullRequestWatchSummary | undefined;
    let watchExisted = false;
    if (ciEvents.length > 0 && headSha && !ciOutcomeAlreadyKnown) {
      const registration = await this.getOverlayStore().registerThreadPrStatusWatch({
        watch: {
          ...baseWatch,
          watchId: randomUUID(),
          headSha,
          notifyOn: ciEvents,
          failureHandledByAutoFix: coversFailure(baseline),
          kind: "checks",
          ...watchRun,
          ...(baseline ? { baseline } : {}),
        },
        now: createdAt,
      });
      watch = registration.watch;
      watchExisted = registration.existed;
    }
    let terminalWatch: ThreadPullRequestWatchSummary | undefined;
    let terminalWatchExisted = false;
    if (terminalEvents.length > 0) {
      // Not bound to a head: pushes and CI results leave it in place until
      // the PR merges or closes, and it survives restarts in sqlite.
      const registration = await this.getOverlayStore().registerThreadPrStatusWatch({
        watch: {
          ...baseWatch,
          watchId: randomUUID(),
          headSha: headSha ?? "",
          notifyOn: terminalEvents,
          failureHandledByAutoFix: false,
          kind: "terminal",
        },
        now: createdAt,
      });
      terminalWatch = registration.watch;
      terminalWatchExisted = registration.existed;
    }
    if (watch || terminalWatch) {
      await this.publishPrWatchesUpdated([{ backend: args.backend, threadId, prKey }]);
    }
    if (watch) {
      // The last poll can publish a terminal status before it can see the
      // new watch. Replay canonical evidence after the registration commits.
      const latest = this.prStatusRegistry.get(this.prRepositoryAliases.canonicalizeKey(prKey));
      if (latest && (isTerminalPullRequest(latest.pr)
        || (!watch.baseline && Date.now() - latest.fetchedAt <= PR_STATUS_WATCH_CURRENT_OUTCOME_MAX_AGE_MS))) {
        await this.getPrStatusWatchCoordinator().handleStatusSnapshot(latest.pr, latest.fetchedAt);
      }
    }

    const coveredByAutoFix: ThreadPullRequestWatchEvent[] =
      ciEvents.includes("failure") && coversFailure(watch?.baseline ?? baseline)
        ? ["failure"]
        : [];
    // Armed only when every requested event has a waiting watch. A merge
    // watch alone must not read as a wait for a CI result that already came.
    const armed = (ciEvents.length === 0 || Boolean(watch))
      && (terminalEvents.length === 0 || Boolean(terminalWatch));
    const reason: WatchThreadPullRequestReason = !armed
      ? "outcome_already_final"
      : (!watch || watchExisted) && (!terminalWatch || terminalWatchExisted)
        ? "already_armed"
        : "armed";
    return {
      ok: true,
      result: {
        ...(watch ? { watch } : {}),
        ...(terminalWatch ? { terminalWatch } : {}),
        ...(ciOutcomeAlreadyKnown && currentOutcome ? { currentOutcome } : {}),
        coveredByAutoFix,
        prAutomation: await this.getThreadPullRequestAutomationStatus({
          backend: args.backend,
          threadId,
        }),
        armed,
        reason,
        message: describePrWatchArming({
          prNumber: pr.number,
          headSha: headSha ?? "",
          ciEvents,
          watch,
          watchExisted,
          terminalWatch,
          terminalWatchExisted,
          knownOutcome: ciOutcomeAlreadyKnown ? currentOutcome : undefined,
          knownAgeMs: observedAt !== undefined ? createdAt - observedAt : undefined,
          pushedHeadSha,
          audience: args.createdBy,
        }),
      },
    };
  }

  /** The operator's list, history, and Stop for PR watches on local threads. */
  async manageThreadPrWatches(
    request: ThreadPrWatchesRequest,
  ): Promise<ThreadPrWatchesResponse> {
    const invalid = (message: string): ThreadPrWatchesResponse => ({
      ok: false,
      error: { code: "invalid_arguments", message },
    });
    if (request?.action === "active") {
      // Before a profile's state opens there is nothing to list, not an error.
      if (!getAppStateMode()) return { ok: true, active: [], autoFix: [] };
      return {
        ok: true,
        active: await this.getOverlayStore().listAllActivePrStatusWatches(),
        autoFix: await this.listThreadPrAutoFixStates(),
      };
    }
    if (
      request?.action !== "history"
      && request?.action !== "cancel"
      && request?.action !== "watch"
    ) {
      return invalid("action must be active, history, cancel, or watch.");
    }
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      return {
        ok: false,
        error: {
          code: "federation_unsupported",
          message: "PR watches run on the instance that owns the thread. Stop them there.",
        },
      };
    }
    if (!isAppServerBackendKind(request.backend) || !request.threadId?.trim()) {
      return invalid("backend and threadId are required.");
    }
    if (request.action === "history") {
      const limit = Math.min(
        THREAD_PR_WATCH_HISTORY_MAX_LIMIT,
        Math.max(1, Math.floor(request.limit ?? 10)),
      );
      return {
        ok: true,
        history: await this.getOverlayStore().listThreadPrStatusWatchHistory({
          backend: request.backend,
          threadId: request.threadId,
          limit: Number.isFinite(limit) ? limit : 10,
        }),
      };
    }
    if (request.action === "watch") {
      if (!request.prUrl?.trim()) return invalid("prUrl is required.");
      // Watch CI asks for the next pass or failure, as an agent's default does.
      const armed = await this.armThreadPrWatch({
        backend: request.backend,
        threadId: request.threadId,
        url: request.prUrl,
        notifyOn: ["success", "failure"],
        createdBy: "operator",
      });
      return armed.ok ? { ok: true, watch: armed.result } : { ok: false, error: armed.error };
    }
    if (!request.watchId?.trim()) return invalid("watchId is required.");
    const cancelled = await this.getOverlayStore().cancelThreadPrStatusWatch({
      backend: request.backend,
      threadId: request.threadId,
      watchId: request.watchId,
      now: Date.now(),
    });
    if (!cancelled) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: "That watch is no longer waiting, or it is waking the thread now.",
        },
      };
    }
    await this.publishPrWatchesUpdated([cancelled]);
    return { ok: true, cancelled: true };
  }

  /** The readers the Waiting for list draws on, all reads of existing state. */
  private pendingWakeReaders(): ThreadPendingWakeReaders {
    const registry = getDesktopBackendRegistry();
    return {
      prWatches: async (thread) => await this.getOverlayStore().listActiveThreadPrStatusWatches(thread),
      prWatchHistory: async (thread, limit) => limit === 0 ? []
        : await this.getOverlayStore().listThreadPrStatusWatchHistory({
          ...thread, limit: Math.min(limit, THREAD_PR_WATCH_HISTORY_MAX_LIMIT),
        }),
      autoFix: async (thread) => await this.listThreadPrAutoFixStates(thread),
      // A plain store read: the coordinator's list waits behind evaluations,
      // and selected detail reads this list.
      dependencies: async (thread, endedLimit) => {
        const dependencies = createThreadDependencyStorage().listPendingWakes(thread.backend, thread.threadId, endedLimit);
        // A waiting CI run shows its latest check, held in memory.
        return this.threadDependencyCoordinator?.withCiRunObservations(dependencies) ?? dependencies;
      },
      scheduledActions: (thread, endedLimit) => getAppScheduledThreadActionStore().listPendingWakes({ ...thread, endedLimit }),
      monitors: (thread) => registry.listPendingTaskMonitorWakes(thread),
      monitorWakesTripped: (thread) => registry.taskMonitorWakesTripped(thread),
      recentSubAgents: async (thread, limit) => limit === 0 ? []
        : await this.getOverlayStore().listEndedThreadTaskMonitors({ ...thread, limit }),
      // Only Claude continues a thread when a background task ends.
      backendTasks: async (thread) => registry.listBackendTaskWakes(thread),
      backendWakes: (thread) => registry.listBackendWakes(thread),
      hold: async (thread) => await registry.readThreadWakeHold(thread),
      heldEntries: (thread) => registry.listHeldThreadQueueEntries(thread),
    };
  }

  /** The thread's pending wakes, for its owner's windows and its detail. */
  async listThreadPendingWakes(
    thread: { backend: AppServerBackendKind; threadId: string },
    endedLimit?: number,
    activePrWatches?: readonly ThreadPullRequestWatchSummary[],
  ): Promise<ThreadPendingWakesList> {
    // Before a profile's state opens nothing can wake a thread.
    if (!getAppStateMode()) return { wakes: [], ended: [] };
    return await this.pendingWakesCache.read(thread, { endedLimit, activePrWatches });
  }

  invalidateThreadPendingWakes(event: AgentEvent): void {
    if (event.federationTarget?.scope === "remote"
      || !isThreadPendingWakeInvalidation(event.notification.method, event.notification.params)) return;
    const params = event.notification.params as { threadId?: unknown; action?: { threadId?: unknown } } | undefined;
    const threadId = params?.threadId ?? params?.action?.threadId;
    this.pendingWakesCache.invalidate(typeof threadId === "string" ? { backend: event.backend, threadId } : undefined);
  }

  /** The Waiting for list and its Stop, for a thread this instance owns. */
  async manageThreadPendingWakes(
    request: ThreadPendingWakesRequest,
  ): Promise<ThreadPendingWakesResponse> {
    if (request?.action === "list_monitor_wake_alerts") {
      return { ok: true, monitorWakeAlerts: getAppStateMode() ? getDesktopBackendRegistry().listTaskMonitorWakeAlerts() : [] };
    }
    if (
      !request
      || (request.action !== "list" && request.action !== "stop"
        && request.action !== "rearm_follow_ups" && request.action !== "rearm_monitor_wakes"
        && request.action !== "acknowledge_monitor_wake_alert")
      || !isAppServerBackendKind(request.backend)
      || typeof request.threadId !== "string"
      || !request.threadId.trim()
    ) {
      return { ok: false, error: { code: "invalid_arguments", message: "action, backend and threadId are required." } };
    }
    const thread = { backend: request.backend, threadId: request.threadId.trim() };
    if (request.action === "list") {
      return { ok: true, ...await this.listThreadPendingWakes(thread, request.endedLimit) };
    }
    if (request.action === "rearm_follow_ups" || request.action === "rearm_monitor_wakes" || request.action === "acknowledge_monitor_wake_alert") {
      // Reached only from this instance's own window; the IPC handler refuses
      // a peer target and a federation window before calling here.
      try {
        if (request.action === "acknowledge_monitor_wake_alert") {
          if (typeof request.generation !== "number" || !Number.isSafeInteger(request.generation)) {
            return { ok: false, error: { code: "invalid_arguments", message: "A Job Monitor alert generation is required." } };
          }
          getDesktopBackendRegistry().acknowledgeTaskMonitorWakeAlert(thread, request.generation);
          return { ok: true };
        }
        if (request.action === "rearm_monitor_wakes") {
          return { ok: true, rearmed: getDesktopBackendRegistry().rearmTaskMonitorWakes(thread, request.generation) };
        }
        await getScheduledThreadActionService().rearmAgentFollowUps(thread);
        return { ok: true, rearmed: true };
      } catch (error) {
        return { ok: false, error: { code: "failed", message: error instanceof Error ? error.message : String(error) } };
      } finally {
        this.pendingWakesCache.invalidate(thread);
      }
    }
    if (request.action !== "stop" || typeof request.key !== "string") {
      return { ok: false, error: { code: "invalid_arguments", message: "key is required." } };
    }
    const registry = getDesktopBackendRegistry();
    try {
      return await stopThreadPendingWake({
        cancelPrWatch: async (owner, watchId) => {
          const response = await this.manageThreadPrWatches({ action: "cancel", ...owner, watchId });
          return response.ok ? { ok: true } : { ok: false, code: response.error.code === "not_found" ? "not_found" : "failed", message: response.error.message };
        },
        cancelDependency: async (owner, dependencyId) => {
          await this.manageThreadDependencies({ action: "cancel", ...owner, dependencyId });
        },
        stopMonitor: async (owner, monitorId) => {
          await registry.stopSubAgent({ ...owner, monitorId });
        },
        cancelScheduledAction: async (owner, actionId) => {
          const service = getScheduledThreadActionService();
          // Cancel takes a bare id; a stop names this thread's wake only.
          if (!getAppScheduledThreadActionStore().ownsPendingWake(owner, actionId)) {
            throw new Error("That scheduled action is no longer waiting on this thread.");
          }
          await service.cancel({ id: actionId });
        },
        stopBackendTask: async (owner, processId) => {
          const { terminated } = await registry.terminateBackgroundTerminal({ ...owner, processId });
          if (!terminated) throw new Error("The task has already ended.");
        },
        discardHeldMessage: async (owner, entryId) => {
          // The queue cancels by bare id; a stop names this thread's entry only.
          // Cancelling a project-held entry also drops its stored copy.
          if (!registry.listHeldThreadQueueEntries(owner).some((entry) => entry.entryId === entryId)
            || !registry.cancelQueuedTurn(entryId, "Discarded from Waiting for.")) {
            throw new Error("That message is no longer held on this thread.");
          }
        },
      }, thread, request.key);
    } finally {
      this.pendingWakesCache.invalidate(thread);
    }
  }

  /**
   * What Auto-fix does on each opted-in thread for each of its PRs. It runs
   * on the elected thread only, and not while the repair budget is paused.
   * Nothing when Git settings stop it, which the windows already know.
   */
  private async listThreadPrAutoFixStates(thread?: { backend: AppServerBackendKind; threadId: string }): Promise<ThreadPrAutoFixState[]> {
    if (!this.backgroundPrPollingEnabled || !this.prAutoDispatchAllowed) return [];
    const candidates = await this.getOverlayStore().listPrAutoDispatchCandidates(thread);
    const winners = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      if (!winners.has(candidate.prKey)) winners.set(candidate.prKey, candidate);
    }
    const selected = thread ? candidates.filter((candidate) => candidate.backend === thread.backend && candidate.threadId === thread.threadId) : candidates;
    return selected.map((candidate): ThreadPrAutoFixState => {
      const lifecycle = this.prStatusRegistry.get(candidate.prKey)?.pr.lifecycleState;
      const base = {
        backend: candidate.backend,
        threadId: candidate.threadId,
        prKey: candidate.prKey,
        // A merged or closed PR has nothing left to repair.
        ...(lifecycle === "merged" || lifecycle === "closed" ? { prEnded: lifecycle } : {}),
      };
      if (this.prAutoDispatchBudgetPaused) return { ...base, state: "paused" };
      const winner = winners.get(candidate.prKey)!;
      if (winner.backend === candidate.backend && winner.threadId === candidate.threadId) {
        return { ...base, state: "active" };
      }
      const title = getDesktopBackendRegistry().getCachedThreadSummary({
        backend: winner.backend,
        threadId: winner.threadId,
      })?.title;
      return {
        ...base,
        state: "handled_by_other_thread",
        handledBy: {
          backend: winner.backend,
          threadId: winner.threadId,
          ...(title ? { title } : {}),
        },
      };
    });
  }

  /** Auto-fix's states changed: opted-in threads' windows re-list them. */
  private async publishPrAutoFixStatesChanged(): Promise<void> {
    const candidates = await this.getOverlayStore().listPrAutoDispatchCandidates();
    const threads = new Map(candidates.map((candidate) => [
      buildThreadIdentityKey(candidate.backend, candidate.threadId),
      { backend: candidate.backend, threadId: candidate.threadId },
    ]));
    await this.publishPrWatchesUpdated([...threads.values()]);
  }

  /** Tell windows a thread's PR watches changed; they re-list them. */
  private async publishPrWatchesUpdated(
    threads: Array<{ backend: AppServerBackendKind; threadId: string; prKey?: string }>,
  ): Promise<void> {
    for (const thread of threads) {
      await getDesktopBackendRegistry().publishLocalEvent({
        backend: thread.backend,
        notification: {
          method: "thread/prWatches/updated",
          params: {
            backend: thread.backend,
            threadId: thread.threadId,
            ...(thread.prKey ? { prKey: thread.prKey } : {}),
          },
        },
      });
    }
  }

  async getThreadPullRequestAutomationStatus(
    params: {
      backend: AppServerBackendKind;
      threadId: string;
    },
    context?: PwrAgentThreadInspectionContext,
  ): Promise<ThreadPullRequestAutomationStatus> {
    const overlay = await this.getOverlayStore().getThreadOverlayState(params);
    const autoFixEnabled = overlay?.prAutoDispatchEnabled === true;
    const attachment = this.attachedPrsByThreadKey.get(
      buildThreadIdentityKey(params.backend, params.threadId),
    );
    const hasPrimaryRepo = Boolean(attachment?.primaryRepoKey);
    const primaryPrs = this.primaryAttachedPrsForThread({
      ...params,
      prs: this.canonicalizePrs(overlay?.prs ?? []),
    });
    const winners = await Promise.all(
      primaryPrs.map(async (pr) =>
        await this.getOverlayStore().getPrAutoDispatchCandidateWinner({
          prKey: getPrStatusKey(pr),
        }),
      ),
    );
    const ownsAttachedPr = winners.some((winner) =>
      winner?.backend === params.backend && winner.threadId === params.threadId,
    );
    const waitingForPr = hasPrimaryRepo && primaryPrs.length === 0;
    // The thread's project can narrow Auto-fix, never widen it.
    const forgeProject = this.resolveThreadForgeProject(params);
    const projectSkipsMergeConflicts = !projectAllowsAutoFixKind(forgeProject?.automation, "merge-conflict");
    const projectSkipsCiFailures = !projectAllowsAutoFixKind(forgeProject?.automation, "ci-failure");
    const projectBlocksAutoFix = projectSkipsMergeConflicts && projectSkipsCiFailures;
    const autoFixActive =
      autoFixEnabled
      && !projectBlocksAutoFix
      && this.isPrAutoDispatchAvailable()
      && (waitingForPr || ownsAttachedPr);
    const isInvokingThread =
      context?.backend === params.backend
      && context.threadId === params.threadId;
    const watches = await this.getOverlayStore().listActiveThreadPrStatusWatches(
      params,
    );
    const baseGuidance = autoFixActive && waitingForPr
      ? "Auto-fix PR monitoring is armed. This is monitoring state, not a repair-turn event. This primary workspace has no linked PR yet; PwrAgent will begin monitoring when one is linked. Do not poll CI or create a monitor thread after a PR is linked."
      : autoFixActive
      ? isInvokingThread
        ? "Auto-fix PR monitoring is active. Reading this status did not start or convert the current turn into a repair turn. autoFixActive only means this thread owns automatic monitoring. Monitoring ownership does not mean another agent is repairing the PR. The current turn is a repair turn only if PwrAgent started it with an Auto-fix PR event. In that repair turn, investigate and fix only the reported failure or conflict, then validate, commit, and push the fix to the PR branch. Do not fix anything else from prior conversation context, including review findings the user did not ask this turn to address. If the current turn has no Auto-fix PR event, do not poll CI or create a monitor; end the turn and PwrAgent will start a repair turn when a new failure or conflict appears. Use watch_thread_pull_request before ending when the thread should also wake on successful completion."
        : "Auto-fix PR monitoring is active for the inspected thread. Reading this status did not start or convert the current turn into a repair turn. autoFixActive only reports the inspected thread's monitoring ownership. This result never authorizes the current turn to repair that thread's PR. Monitoring ownership does not mean another agent is already repairing it. The inspected thread will receive its own repair turn for a new CI failure or merge conflict."
      : autoFixEnabled
        ? this.backgroundPrPollingEnabled
          ? this.prAutoDispatchAllowed
            ? this.prAutoDispatchBudgetPaused
              ? "Auto-fix PR is paused because the profile's automatic repair budget is empty. Thread-level preferences were left unchanged; resume it from the safety notice when you are ready."
              : hasPrimaryRepo
                ? "Auto-fix PR is enabled, but an older eligible thread owns monitoring for this PR. Do not poll CI or create another monitor; the elected thread receives the PR event."
                : "Auto-fix PR is enabled, but this thread has no GitHub primary workspace. PwrAgent cannot monitor PR automation for it; check the PR directly until the thread is attached to a Git workspace."
            : "Auto-fix PR is saved but disabled globally in Git settings. Do not assume PwrAgent will wake this thread until automatic PR repair is allowed again."
          : "Auto-fix PR is saved but paused because background PR polling is off. Do not assume PwrAgent will wake this thread until polling is enabled."
        : this.backgroundPrPollingEnabled
          ? this.prAutoDispatchAllowed
            ? this.prAutoDispatchBudgetPaused
              ? "Background PR polling is active, but Auto-fix PR is paused because the profile's automatic repair budget is empty. Resume it from the safety notice when you are ready."
              : "Background PR polling is active, but Auto-fix PR is off for this thread. Use watch_thread_pull_request for a bounded one-shot success, failure, merge, or close notification instead of polling or creating a monitor thread."
            : "Background PR polling is active, but automatic PR repair is disabled globally in Git settings. Use watch_thread_pull_request for a bounded one-shot success, failure, merge, or close notification instead of polling or creating a monitor thread."
          : "Background PR polling and Auto-fix PR are off. PwrAgent will not wake this thread for PR status changes.";
    const projectSkippedKind = projectSkipsMergeConflicts ? "merge conflicts" : "failing CI";
    const handsOffPrs = forgeProject?.automation.handsOff
      ? primaryPrs.flatMap((pr) => {
        const match = this.prHandsOff(params, pr);
        return match ? [{ pr, match }] : [];
      })
      : [];
    const handsOffGuidance = handsOffPrs.map(({ pr, match }) => buildHandsOffGuidance({
      projectLabel: forgeProject!.label,
      pullRequest: `${pr.org}/${pr.repo}#${pr.number}`,
      match,
    }));
    // By URL: a fork and its upstream number their PRs independently.
    const handsOffUrls = new Set(handsOffPrs.map(({ pr }) => pr.url));
    // A PR switched off here left this thread's candidacy, so no election
    // explains it; say so rather than blame an older thread.
    const switchedOffPrs = autoFixEnabled
      ? primaryPrs.filter((pr) => pr.autoFixOff === true && !handsOffUrls.has(pr.url))
      : [];
    const switchedOffGuidance = switchedOffPrs.map((pr) =>
      `Auto-fix is switched off for ${pr.org}/${pr.repo}#${pr.number} in this thread, so PwrAgent will not start a repair turn for it here. Do not poll its CI or create a monitor in its place; the operator can switch it back on in the thread's Pull requests panel or the composer's Auto-fix menu.`);
    const everyPrSwitchedOff = primaryPrs.length > 0
      && primaryPrs.every((pr) => pr.autoFixOff === true || handsOffUrls.has(pr.url));
    const reviewReadiness = (await this.readPrReviewReadiness(params, primaryPrs))
      .filter((entry) => !handsOffUrls.has(entry.prUrl));
    const neverMerge = forgeProject && projectNeverMerges(forgeProject.automation) ? forgeProject.label : undefined;
    const mergeBranches = projectMergeBranches(forgeProject?.automation);
    const readinessGuidance = reviewReadiness
      .filter((entry) => entry.readiness !== "closed")
      .map((entry) => {
        // A PR into a branch the project still merges into reads as in any project.
        const blocked = neverMerge && !projectMergesPullRequest(
          forgeProject?.automation,
          primaryPrs.find((pr) => pr.number === entry.prNumber)?.baseRefName,
        );
        return describePrReviewReadiness({
          prNumber: entry.prNumber,
          readiness: entry.readiness as Parameters<typeof describePrReviewReadiness>[0]["readiness"],
          ...(entry.headSha ? { headSha: entry.headSha } : {}),
          reviewed: entry.reviewed,
          ...(entry.openFindings !== undefined ? { openFindings: entry.openFindings } : {}),
          ...(blocked ? { neverMergeProject: neverMerge } : {}),
          ...(blocked && mergeBranches.length ? { mergeBranches } : {}),
        });
      });
    const automationGuidance = autoFixEnabled && forgeProject && projectBlocksAutoFix
      ? `Auto-fix PR is saved for this thread, but it is in ${forgeProject.label}, where ${forgeProject.automation.paused ? "forge activity is paused" : "Auto-fix is turned off in Forge Automation"}. PwrAgent will not start a repair turn. Do not poll CI or create a monitor in its place. Tell the operator, who can change it from the project menu: Forge Automation.`
      : autoFixActive && forgeProject && (projectSkipsMergeConflicts || projectSkipsCiFailures)
        ? `${baseGuidance} ${forgeProject.label} skips ${projectSkippedKind} in Forge Automation, so PwrAgent will not start a repair turn for ${projectSkippedKind}.`
        : baseGuidance;
    // Readiness lines name the project only for PRs this thread owns offers
    // for; any other thread in a never-merge project still hears it, unless
    // every PR it shows targets a branch the project still merges into.
    const showsOnlyMergeablePrs = primaryPrs.length > 0
      && primaryPrs.every((pr) => projectMergesPullRequest(forgeProject?.automation, pr.baseRefName));
    const neverMergeGuidance = neverMerge && readinessGuidance.length === 0 && !showsOnlyMergeablePrs
      ? [buildProjectNeverMergeRefusal({ projectLabel: neverMerge, mergeBranches })]
      : [];
    const stackGuidance = await this.threadStackGuidance(primaryPrs);
    const stackLines = stackGuidance.map(({ text }) => text);
    const guidance = (stackGuidance.some(({ held }) => held)
      ? [...stackLines, ...handsOffGuidance, ...switchedOffGuidance, ...neverMergeGuidance]
      : [
        ...stackLines,
        ...handsOffGuidance,
        ...switchedOffGuidance,
        ...(everyPrSwitchedOff && !autoFixActive && switchedOffPrs.length > 0 ? [] : [automationGuidance]),
        ...readinessGuidance,
        ...neverMergeGuidance,
      ]).join(" ");
    return {
      backgroundPollingEnabled: this.backgroundPrPollingEnabled,
      autoFixAllowed: this.prAutoDispatchAllowed,
      autoFixEnabled,
      autoFixActive,
      ...(overlay?.prAutoDispatchPending
        ? { autoFixPending: overlay.prAutoDispatchPending }
        : {}),
      ...(watches.length > 0 ? { watches } : {}),
      ...(reviewReadiness.length > 0 ? { reviewReadiness } : {}),
      ...this.readThreadForgeAutomationGates(params, primaryPrs),
      guidance,
    };
  }

  /** `prAutomation.forgeAutomation`: the rules, and what they make of each PR. */
  private readThreadForgeAutomationGates(
    ref: { backend: AppServerBackendKind; threadId: string },
    prs: PrSummary[],
  ): { forgeAutomation?: ThreadForgeAutomationGates } {
    const index = getProjectForgeAutomationIndex();
    const directoryKey = this.threadForgeDirectoryKey(ref);
    if (!directoryKey) return {};
    const automation = resolveProjectForgeAutomation(index.get(directoryKey));
    return {
      forgeAutomation: {
        project: index.label(directoryKey),
        handsOff: (automation.handsOff ?? []).map((rule) => ({ ...rule })),
        pullRequests: prs.map((pr) => {
          const match = findHandsOffMatch(automation, pr);
          return {
            url: pr.url,
            ...(pr.labels ? { labels: [...pr.labels] } : {}),
            ...(match ? {
              handsOff: {
                repository: match.rule.repository,
                ...(match.rule.label ? { label: match.rule.label } : {}),
                ...(match.label !== undefined ? { matchedLabel: match.label } : {}),
              },
            } : {}),
            ...(pr.autoFixOff ? { autoFixOff: true as const } : {}),
          };
        }),
      },
    };
  }

  private async threadStackGuidance(
    prs: PrSummary[],
  ): Promise<Array<{ text: string; held?: boolean }>> {
    if (!prs.length) return [];
    const readScope = this.createPrStackScopeReader();
    const scoped = await Promise.allSettled(prs.map((pr) => this.readPrStacks(pr, readScope)));
    return prs.flatMap((pr, offset) => {
      const result = scoped[offset]!;
      if (result.status === "rejected") {
        appServerLog.debug("could not read PR stack guidance", { pr: pr.url, error: String(result.reason) });
        return [{ text: `#${pr.number} is held while stack settlement is unavailable.`, held: true }];
      }
      const candidates = result.value;
      const stack = candidates.find((entry) => entry.layers.some((layer) => layer.pullRequest?.number === pr.number
        && stackDispatchBlock(layer))) ?? candidates[0];
      if (!stack) return [];
      const index = stack.layers.findIndex((layer) => layer.pullRequest?.number === pr.number);
      const layer = stack.layers[index]!;
      const hold = stackDispatchBlock(layer);
      if (hold) {
        const lower = hold.number === undefined ? hold.branch : `#${hold.number}`;
        const next = layer.heldBy
          ? `PwrAgent advances this layer after ${lower} settles and publishing is authorized.`
          : "PwrAgent checks the replacement head before acting on CI.";
        return [{ text: `#${pr.number} is held. ${describeStackAutomationBlock(hold)}. Don't rebase, fix CI, or push this layer now. ${next}`, held: true }];
      }
      const parent = layer.activeBase ? undefined : stack.layers[index - 1]?.pullRequest?.number;
      return [{ text: `#${pr.number} is layer ${index + 1} of ${stack.layers.length} in ${stack.inferred ? "inferred " : ""}stack ${stack.name}, with expected base ${layer.activeBase ?? layer.parent}${parent === undefined ? "" : ` (#${parent})`} and health ${layer.health.replaceAll("_", " ")}. Merge or enable auto-merge only after all lower layers have merged and the PR targets ${stack.trunk}.` }];
    });
  }

  async detachThreadPullRequest(
    request: DetachThreadPullRequestRequest,
  ): Promise<DetachThreadPullRequestResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      // PR attachments live on the owning instance; detaching locally
      // would only write a phantom row into the viewer's overlay store
      // that the next remote snapshot reverts.
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .detachThreadPullRequest(remoteRequest);
    }
    const backend = request.backend ?? "codex";
    const prKey = getPrStatusKey(request.pr);
    const currentPr = this.prStatusRegistry.get(prKey)?.pr;
    let overlay = await this.getOverlayStore().detachThreadPullRequest({
      backend,
      threadId: request.threadId,
      pr: request.pr,
    });
    // A row still stored under a renamed repository's old name is the same
    // PR; the client only saw its canonical chip.
    let cancelledWatches = 0;
    for (const alias of (overlay.prs ?? []).filter((pr) =>
      getPrStatusKey(pr) !== prKey
      && getPrStatusKey(this.prRepositoryAliases.canonicalize(normalizePrSummary(pr))) === prKey
    )) {
      overlay = await this.getOverlayStore().detachThreadPullRequest({
        backend,
        threadId: request.threadId,
        pr: alias,
      });
      cancelledWatches += await this.getOverlayStore().cancelThreadPrStatusWatchesForPr({
        backend,
        threadId: request.threadId,
        prKey: getPrStatusKey(alias),
        now: Date.now(),
      });
    }
    cancelledWatches += await this.getOverlayStore().cancelThreadPrStatusWatchesForPr({
      backend,
      threadId: request.threadId,
      prKey,
      now: Date.now(),
    });
    if (cancelledWatches > 0) {
      await this.publishPrWatchesUpdated([{ backend, threadId: request.threadId, prKey }]);
    }
    const prs = overlay.prs ?? [];
    await this.publishThreadPullRequestsUpdated({
      backend,
      threadId: request.threadId,
      prs,
      detachedPrs: overlay.detachedPrs ?? [],
    });
    await this.getPrAutoDispatchCoordinator().cancelPendingForPr({
      backend,
      threadId: request.threadId,
      prKey,
    });
    if (currentPr && this.backgroundPrPollingEnabled) {
      await this.handlePrAutoDispatchSnapshots(
        [currentPr],
        this.nextPrObservationTimestamp(),
        true,
      );
    }
    return {
      backend,
      threadId: request.threadId,
      detachedPrKeys: overlay.detachedPrKeys ?? [],
      prs,
    };
  }

  /**
   * Switch Auto-fix off, or back on, for one PR of a thread whose Auto-fix
   * stays on. The PR leaves the thread's candidacy, so the election either
   * hands it to another thread that holds it or leaves it unrepaired.
   */
  async setThreadPullRequestAutoFix(request: {
    backend: AppServerBackendKind;
    threadId: string;
    prKey: string;
    enabled: boolean;
  }): Promise<void> {
    const prKey = this.prRepositoryAliases.canonicalizeKey(request.prKey);
    const { state, changed } = await this.getOverlayStore().setThreadPullRequestAutoFixOff({
      backend: request.backend,
      threadId: request.threadId,
      matchesPrKey: (storedKey) => this.prRepositoryAliases.canonicalizeKey(storedKey) === prKey,
      off: !request.enabled,
    });
    if (!changed || !state) return;
    await this.publishThreadPullRequestsUpdated({
      backend: request.backend,
      threadId: request.threadId,
      prs: state.prs ?? [],
      detachedPrs: state.detachedPrs ?? [],
    });
    if (!request.enabled) {
      await this.getPrAutoDispatchCoordinator().cancelPendingForPr({
        backend: request.backend,
        threadId: request.threadId,
        prKey,
      });
    }
    const currentPr = this.prStatusRegistry.get(prKey)?.pr;
    if (currentPr && this.backgroundPrPollingEnabled) {
      await this.handlePrAutoDispatchSnapshots([currentPr], this.nextPrObservationTimestamp(), true);
    }
  }

  /** Hold watch election while a merge button's forge write is still in flight. */
  async runObservedThreadPullRequestMerge(
    thread: { backend: AppServerBackendKind; threadId: string },
    url: string,
    run: () => Promise<ThreadPullRequestMergeResult>,
  ): Promise<ThreadPullRequestMergeResult> {
    const ref = parsePullRequestReferenceUrl(url);
    if (!ref) throw new Error("That is not a pull request URL.");
    const key = this.prRepositoryAliases.canonicalizeKey(getPrStatusKey(ref));
    if (this.prCardMerges.has(key)) throw new Error("A merge is already in progress for this pull request.");
    const pending: { transition?: PrStatusTransition } = {};
    this.prCardMerges.set(key, pending);
    let merged = false;
    try {
      const result = await run();
      if (result.mergedUrl) {
        merged = !result.alreadyMerged;
        await this.recordThreadPullRequestMerge(thread, url, result).catch((error: unknown) => {
          appServerLog.warn("could not record confirmed pull request merge", {
            prKey: key, error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return result;
    } finally {
      this.prCardMerges.delete(key);
      if (pending.transition) {
        this.startMergeBuildWatch(pending.transition, merged ? buildThreadIdentityKey(thread.backend, thread.threadId) : undefined);
      }
    }
  }

  private async recordThreadPullRequestMerge(
    thread: { backend: AppServerBackendKind; threadId: string },
    requestedUrl: string,
    merge: Extract<ThreadPullRequestMergeResult, { mergedUrl: string }>,
  ): Promise<void> {
    await this.loadPrStatusRegistry();
    const overlay = await this.getOverlayStore().getThreadOverlayState(thread);
    const ref = parsePullRequestReferenceUrl(merge.mergedUrl)!;
    const identity = { provider: ref.provider, org: ref.org, repo: ref.repo, number: ref.number, url: ref.url };
    const key = getPrStatusKey(identity);
    const requested = parsePullRequestReferenceUrl(requestedUrl)!;
    const requestedKey = this.prRepositoryAliases.canonicalizeKey(getPrStatusKey(requested));
    const current = this.prStatusRegistry.get(key)?.pr;
    const previous = current ?? this.prStatusRegistry.get(requestedKey)?.pr
      ?? this.canonicalizePrs(overlay?.prs ?? []).find((pr) => getPrStatusKey(pr) === requestedKey)
      ?? { ...identity, state: "unknown" as const };
    if (requestedKey !== key) this.learnPullRequestRepository(requestedUrl, { ...previous, ...identity });
    if (current?.lifecycleState === "merged") return;
    if (!current) this.rememberPrStatuses([{ ...previous, ...identity }], 0, "merge-card-attachment");
    const observedAt = this.nextPrObservationTimestamp();
    const { changed } = this.rememberPrStatuses([{
      ...previous, ...identity, lifecycleState: "merged", mergeQueue: undefined,
      ...(!merge.alreadyMerged ? { mergedAt: Date.now() } : {}),
    }], observedAt, "in-app-merge", { skipMergeBuildWatch: merge.alreadyMerged });
    if (!changed.length) return;
    // Other forge consumers can do their own follow-up reads after the
    // mutation. The status event and cache need only the successful write.
    void this.handlePrAutoDispatchSnapshots(changed, observedAt).catch((error: unknown) => {
      appServerLog.warn("pull request merge follow-up failed", { prKey: key, error: String(error) });
    });
    void this.threadDependencyCoordinator?.handlePrEvent([ref.url])
      .catch((error: unknown) => appServerLog.warn("thread dependency evaluation failed", { error: String(error) }));
    await Promise.all([
      this.writePrStatusesToCache(changed, observedAt),
      this.publishPullRequestStatusUpdates({ backend: thread.backend, prs: changed }),
    ]);
  }

  private rememberPrStatuses(
    prs: PrSummary[],
    fetchedAt: number,
    source: string,
    options: {
      skipMergeBuildWatch?: boolean;
      fetchedAtByKey?: ReadonlyMap<string, number>;
      transcriptOnlyPrs?: PrSummary[];
    } = {},
  ): PrStatusObservations {
    const accepted: PrSummary[] = [];
    const changed: PrSummary[] = [];
    const cacheChanged: PrSummary[] = [];
    const transitions: PrStatusTransition[] = [];
    const staleKeys: string[] = [];
    const labelChangedKeys: string[] = [];
    const endedChanged = new Set<string>();
    for (const observed of prs) {
      const normalized = stripPrLinkedDirectoryPaths(observed);
      const key = getPrStatusKey(normalized);
      const prFetchedAt = options.fetchedAtByKey?.get(key) ?? fetchedAt;
      const current = this.prStatusRegistry.get(key);
      // A merge is irreversible. Reads started either side of the write can
      // briefly report the pre-merge state.
      if (current && (current.fetchedAt > prFetchedAt
        || (current.pr.lifecycleState === "merged" && normalized.lifecycleState !== "merged"))) {
        staleKeys.push(key);
        continue;
      }
      const pr = stabilizeGithubPrMergeState(current?.pr, normalized);
      if (!current || !prSummariesEqual([current.pr], [pr])) {
        changed.push(pr);
        cacheChanged.push(pr);
        // A meaningful field flip (CI, merge, conflict, draft, title) becomes a
        // typed transition. `current?.pr` undefined (first sight / cache load)
        // yields no transition, so boot does not emit a flood.
        const transition = computePrStatusTransition(current?.pr, pr);
        if (transition) {
          transition.threadKeys = this.findThreadKeysForPrKey(key);
          transitions.push(transition);
        }
        // Labels move no readiness field, but they can make a PR hands-off,
        // which withdraws its offer cards or lets them return.
        if (current && JSON.stringify(current.pr.labels ?? null) !== JSON.stringify(pr.labels ?? null)) {
          labelChangedKeys.push(key);
        }
        if (current && isTerminalPullRequest(current.pr) !== isTerminalPullRequest(pr)) {
          endedChanged.add(key);
        }
      } else if (pr.baseSha !== current.pr.baseSha && confirmedGithubPrMergeState(pr)) {
        // A confirmed result applies to this base tip after a restart too.
        // Advancing the baseline alone doesn't change the published status.
        cacheChanged.push(pr);
      }
      this.prStatusRegistry.set(key, {
        ...current,
        pr,
        fetchedAt: prFetchedAt,
      });
      this.applyPrStatusToAttachments(pr);
      accepted.push(pr);
    }
    const transcriptPrs = options.transcriptOnlyPrs ? [...accepted, ...options.transcriptOnlyPrs] : accepted;
    this.transcriptPrSubscriptions.observe(transcriptPrs, fetchedAt, options.fetchedAtByKey);
    this.githubForgeStackDiscovery.observe(prs);
    if (staleKeys.length > 0) {
      // Losing to a newer registry entry is ordinary bookkeeping: cache loads
      // and overlay seeds observe at timestamp 0, so every known PR reports one.
      // A single bounded debug line keeps the detail reachable through
      // Help -> Logs without burying the startup log under a line per PR.
      appServerLog.debug("pr status observations ignored as stale", {
        source,
        observedAt: fetchedAt,
        staleCount: staleKeys.length,
        prKeys: staleKeys.slice(0, STALE_PR_OBSERVATION_LOG_SAMPLE),
      });
    }
    if (transitions.length > 0) {
      this.emitPrStatusTransitions(transitions, { observedAt: fetchedAt, source }, options.fetchedAtByKey);
      if (!options.skipMergeBuildWatch) this.armMergeBuildWatches(transitions);
    }
    if (labelChangedKeys.length > 0) this.prReviewOfferCoordinator?.reevaluate(labelChangedKeys);
    this.publishPrAutoFixPrEndedChanges(endedChanged);
    return { accepted, changed, cacheChanged };
  }

  /**
   * `[git] watch_merge_builds`: a PR this instance watched just merged, so
   * one eligible local thread watches the build of its merge commit and
   * wakes only if that build fails. Only a merge seen happening arms one. A
   * merged PR loaded from cache or found later has no transition, and a
   * merge older than a few hours is left alone.
   */
  private armMergeBuildWatches(transitions: readonly PrStatusTransition[]): void {
    const merged = transitions.filter((transition) => transition.changed.lifecycleState?.to === "merged"
      && (transition.pr.mergedAt === undefined || Date.now() - transition.pr.mergedAt < MERGE_BUILD_ARM_MAX_AGE_MS));
    if (!merged.length || !getAppStateMode() || !this.ownerNavigationActive) return;
    for (const transition of merged) {
      const pending = this.prCardMerges.get(transition.prKey)
        ?? this.prRepositoryAliases.equivalentStatusKeys(transition.prKey)
          .map((key) => this.prCardMerges.get(key)).find(Boolean);
      if (pending) pending.transition = transition;
      else this.startMergeBuildWatch(transition);
    }
  }

  private startMergeBuildWatch(transition: PrStatusTransition, preferredThreadKey?: string): void {
    void this.electMergeBuildWatch(transition, preferredThreadKey).catch((error: unknown) =>
      appServerLog.warn("merge build watch could not be armed", {
        prKey: transition.prKey, error: error instanceof Error ? error.message : String(error),
      }));
  }

  private async electMergeBuildWatch(transition: PrStatusTransition, preferredThreadKey?: string): Promise<void> {
    const ordered = new Set([...(preferredThreadKey ? [preferredThreadKey] : []), ...transition.threadKeys.toSorted()]);
    const globalDefault = getDesktopSettingsService().resolveWatchMergeBuilds();
    const registry = getDesktopBackendRegistry();
    for (const threadKey of ordered) {
      const identity = parseThreadIdentityKey(threadKey);
      if (!identity || registry.getThreadInfo(identity)?.archived === true) continue;
      if (!projectWatchesMergeBuilds(this.threadKeyForgeAutomation(threadKey), globalDefault)) continue;
      const result = await this.getThreadDependencyCoordinator().armMergeBuild(
        identity, { url: transition.url, title: transition.title });
      if (result === "armed") appServerLog.info("merge build watch armed", { prKey: transition.prKey, threadId: identity.threadId });
      if (result !== "ineligible") return;
    }
  }

  private nextPrObservationTimestamp(): number {
    const observedAt = Math.max(
      Date.now(),
      this.lastPrObservationTimestamp + 1,
    );
    this.lastPrObservationTimestamp = observedAt;
    return observedAt;
  }

  /**
   * Subscribe to PR status transitions without coupling consumers to polling.
   * Returns an unsubscribe function.
   */
  onPrStatusTransition(listener: PrStatusTransitionListener): () => void {
    this.prStatusTransitionListeners.add(listener);
    return () => {
      this.prStatusTransitionListeners.delete(listener);
    };
  }

  private emitPrStatusTransitions(
    transitions: PrStatusTransition[],
    observation: { observedAt: number; source: string },
    fetchedAtByKey?: ReadonlyMap<string, number>,
  ): void {
    for (const transition of transitions) {
      appServerLog.info(
        "pr status transition",
        {
          ...summarizePrStatusTransition(transition),
          ...observation,
          observedAt: fetchedAtByKey?.get(transition.prKey) ?? observation.observedAt,
        },
      );
      this.prReviewOfferCoordinator?.handleTransition(transition);
      for (const listener of this.prStatusTransitionListeners) {
        try {
          listener(transition);
        } catch (error) {
          appServerLog.warn("pr status transition listener failed", {
            prKey: transition.prKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /** Resolve only primary visible attachments; detached and informational links never qualify. */
  private findThreadKeysForPrKey(prKey: string): string[] {
    return [...(this.primaryPrThreadsByKey.get(prKey) ?? [])];
  }

  /**
   * True when this instance already owns the status of a PR, because the
   * PR is attached to the primary workspace of one of its own threads —
   * the same test `collectPrPollTargets` uses to decide what to poll.
   *
   * Terminal PRs count. They drop out of the poll rotation, but the
   * status this instance last observed for them is final, so a peer's
   * observation of the same PR must not be allowed to overwrite it.
   *
   * Note the primary-workspace qualifier: a PR attached to a local
   * thread but not to its primary repository is deliberately NOT ours.
   * `collectPrPollTargets` skips those too, so we hold no fresher view
   * of them than the peer does — deferring is the better answer.
   */
  isPullRequestLocallyMonitored(prKey: string): boolean {
    return this.findThreadKeysForPrKey(prKey).length > 0;
  }

  private async loadPrStatusRegistry(): Promise<void> {
    if (this.prStatusRegistryLoaded) {
      return;
    }
    if (!this.prStatusRegistryLoadPromise) {
      this.prStatusRegistryLoadPromise = (async () => {
        const entries = await this.getOverlayStore().readPrStatusCache();
        for (const entry of Object.values(entries)) {
          this.rememberPrStatuses([entry.pr], entry.fetchedAt, "pr-status-cache");
        }
        this.prStatusRegistryLoaded = true;
      })();
    }
    const loadPromise = this.prStatusRegistryLoadPromise;
    try {
      await loadPromise;
    } finally {
      if (this.prStatusRegistryLoadPromise === loadPromise) {
        this.prStatusRegistryLoadPromise = undefined;
      }
    }
  }

  /** Identical observations can advance freshness while a changed status is awaiting delivery. */
  private matchingPrStatus(pr: PrSummary): PrStatusRegistryEntry | undefined {
    const key = this.prRepositoryAliases.canonicalizeKey(getPrStatusKey(pr));
    const current = this.prStatusRegistry.get(key);
    return current && prSummariesEqual([current.pr], [stripPrLinkedDirectoryPaths(pr)]) ? current : undefined;
  }

  private async writePrStatusesToCache(
    prs: PrSummary[],
    fetchedAt: number,
    fetchedAtByKey?: ReadonlyMap<string, number>,
  ): Promise<void> {
    const entries: PrStatusCacheEntry[] = prs.flatMap((pr) => {
      const current = this.matchingPrStatus(pr);
      const prFetchedAt = fetchedAtByKey?.get(getPrStatusKey(pr)) ?? fetchedAt;
      if (!current || current.fetchedAt < prFetchedAt) return [];
      // Keep this observation's timestamp. The cache's own ordering guard
      // drops the write if an agreeing, fresher result is already durable.
      return [{ provider: current.pr.provider, prKey: getPrStatusKey(current.pr), fetchedAt: prFetchedAt, pr: current.pr }];
    });
    if (entries.length) await this.getOverlayStore().writePrStatusCacheEntries(entries);
  }

  /**
   * Rows under the forge's repository name with the registry's status, one per
   * PR. A row stored under a renamed repository's old name and the same PR
   * under the new name share one key here, so they merge: the first keeps its
   * position, attachment intent and directory provenance are united.
   */
  private canonicalizePrs(prs: PrSummary[]): PrSummary[] {
    const merged: PrSummary[] = [];
    const renamed: boolean[] = [];
    const indexes = new Map<string, number>();
    for (const pr of prs) {
      const stored = normalizePrSummary(pr);
      const aliased = this.prRepositoryAliases.canonicalize(stored);
      const normalized = aliased === stored ? stored : normalizePrSummary(aliased);
      const key = getPrStatusKey(normalized);
      const status = this.prStatusRegistry.get(key)?.pr;
      const row = status
        ? normalizePrSummary({
            ...status,
            linkedDirectoryPaths: normalized.linkedDirectoryPaths,
            ...pullRequestAttachmentIntent(normalized),
          })
        : normalized;
      const existingIndex = indexes.get(key);
      if (existingIndex === undefined) {
        indexes.set(key, merged.length);
        merged.push(row);
        renamed.push(aliased !== stored);
        continue;
      }
      const existing = merged[existingIndex]!;
      // Without a registry status, a row the forge stored under the current
      // name is fresher than one rewritten from an old name.
      const base = renamed[existingIndex] && aliased === stored ? row : existing;
      renamed[existingIndex] = renamed[existingIndex]! && aliased !== stored;
      merged[existingIndex] = normalizePrSummary({
        ...base,
        linkedDirectoryPaths: mergeLinkedDirectoryPaths(
          existing.linkedDirectoryPaths,
          row.linkedDirectoryPaths,
        ),
        ...pullRequestAttachmentIntent(existing, row),
      });
    }
    return merged;
  }

  /**
   * Whether a write would move a thread's stored rows or detached keys to the
   * forge's repository names. Detached rows are left out: they keep the name
   * they were detached under, and their keys carry the decision.
   */
  private storedPrsNeedRename(state: ThreadOverlayState | undefined): boolean {
    if (!state || !this.prRepositoryAliases.hasRenames()) return false;
    return (state.prs ?? []).some((pr) =>
      getPrStatusKey(this.prRepositoryAliases.canonicalize(normalizePrSummary(pr))) !== getPrStatusKey(pr)
    ) || (state.detachedPrKeys ?? []).some((key) => {
      const folded = key.trim().toLowerCase();
      return this.prRepositoryAliases.canonicalizeKey(folded) !== folded;
    });
  }

  /** Store option that keeps detachments recorded under a renamed repository's old name. */
  private detachedPrKeyCanonicalizer(): { canonicalizePrKey?: (key: string) => string } {
    return this.prRepositoryAliases.hasRenames()
      ? { canonicalizePrKey: (key) => this.prRepositoryAliases.canonicalizeKey(key) }
      : {};
  }

  /** Record what the forge answered for a by-URL fetch. */
  private learnPullRequestRepository(requestedUrl: string, returned: PrSummary | undefined): void {
    if (!this.prRepositoryAliases.learn(requestedUrl, returned)) return;
    this.prRepositoryAliasGeneration += 1;
    // A thread's primary PRs can now include rows under either name.
    for (const [threadKey, attachment] of this.attachedPrsByThreadKey) {
      this.setThreadPrAttachment(threadKey, attachment);
    }
    // The poller no longer fetches a merged or closed PR, so a merge watch
    // saved under the old name needs its cached status offered again. A poll
    // can learn several renames at once; one retry scan covers them all.
    if (!this.prRenameRetryQueued) {
      this.prRenameRetryQueued = true;
      queueMicrotask(() => {
        this.prRenameRetryQueued = false;
        void this.retryPendingPrTerminalWatches().catch((error) => {
          appServerLog.warn("pr terminal watch retry after a repository rename failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    }
    const requested = parsePullRequestReferenceUrl(requestedUrl);
    appServerLog.info("forge answered a pull request under another repository name", {
      requested: requested ? `${requested.provider}/${requested.org}/${requested.repo}` : requestedUrl,
      canonical: returned?.url,
    });
  }

  /**
   * Ask the forge which repository a PR URL names now, for an attach. One
   * by-URL fetch from the shared budget; undefined when it cannot answer.
   */
  async resolvePullRequestReference(params: {
    url: string;
    cwd?: string;
  }): Promise<PullRequestReferenceIdentity | undefined> {
    const requested = parsePullRequestReferenceUrl(params.url);
    if (!requested) return undefined;
    const known = parsePullRequestReferenceUrl(this.prRepositoryAliases.canonicalizeUrl(params.url));
    if (known && (known.org !== requested.org || known.repo !== requested.repo)) {
      return known;
    }
    if (!this.takePrPollingToken("Agent PR attach")) return undefined;
    const pr = await this.getPrFetcher().fetchPullRequestByUrl({
      cwd: params.cwd ?? os.homedir(),
      url: params.url,
    });
    this.learnPullRequestRepository(params.url, pr);
    const answered = parsePullRequestReferenceUrl(pr?.url);
    return answered
      && answered.provider === requested.provider
      && answered.number === requested.number
      ? answered
      : undefined;
  }

  /**
   * A stored PR URL under the repository name the forge reports now. Asks the
   * forge at most once per URL per session, or again after a failed answer,
   * because learned names live in memory and a reference saved under an old
   * name has nothing else to learn it from after a restart.
   */
  private async resolveCurrentPullRequestUrl(url: string, cwd?: string): Promise<string | undefined> {
    const known = this.prRepositoryAliases.canonicalizeUrl(url);
    if (known !== url) return known;
    const now = Date.now();
    const cached = this.prReferenceResolutions.get(url);
    if (cached && (cached.answered || now - cached.askedAt < PR_REFERENCE_RETRY_MS)) {
      return await cached.result;
    }
    const entry = {
      askedAt: now,
      answered: false,
      result: this.resolvePullRequestReference({ url, ...(cwd ? { cwd } : {}) })
        .then((identity) => identity ? this.prRepositoryAliases.canonicalizeUrl(url) : undefined)
        .catch(() => undefined),
    };
    this.prReferenceResolutions.set(url, entry);
    const result = await entry.result;
    entry.answered = result !== undefined;
    return result;
  }

  /**
   * Move stored watch keys to the repository names the forge has answered
   * with, once per learned rename. Status snapshots carry the new name and a
   * claim matches its key exactly.
   */
  private syncPrStatusWatchKeys(): Promise<void> {
    const run = this.prWatchKeySync.then(async () => {
      const generation = this.prRepositoryAliasGeneration;
      if (generation === this.prWatchKeysGeneration) return;
      try {
        const moved = await this.getOverlayStore().canonicalizeThreadPrStatusWatchKeys({
          canonicalizePrKey: (key) => this.prRepositoryAliases.canonicalizeKey(key),
          canonicalizePrUrl: (url) => this.prRepositoryAliases.canonicalizeUrl(url),
          now: Date.now(),
        });
        this.prWatchKeysGeneration = generation;
        if (moved > 0) {
          appServerLog.info("pr status watches moved to a renamed repository", { watchCount: moved });
        }
      } catch (error) {
        // Claims still run; the next one tries the move again.
        appServerLog.warn("pr status watch rename failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    this.prWatchKeySync = run;
    return run;
  }

  /**
   * Ask the forge about watches whose PR is attached to their thread only
   * under another repository name. Stored rows and status snapshots already
   * use a renamed repository's new name, so after a restart a watch saved
   * under the old one has nothing else to learn the rename from.
   */
  private async resolveRenamedPrWatchRepositories(): Promise<void> {
    if (!this.backgroundPrPollingEnabled) return;
    const store = this.getOverlayStore();
    const watches = await store.listAllActiveThreadPrStatusWatches();
    if (watches.length === 0) return;
    await this.loadPrStatusRegistry();
    const asked = new Set<string>();
    // A thread usually holds a CI watch and a merge watch for the same PR.
    const rowsByThread = new Map<string, PrSummary[]>();
    for (const watch of watches) {
      if (asked.has(watch.prUrl)) continue;
      const prKey = this.prRepositoryAliases.canonicalizeKey(watch.prKey);
      const threadKey = buildThreadIdentityKey(watch.backend, watch.threadId);
      let rows = rowsByThread.get(threadKey);
      if (!rows) {
        const overlay = await store.getThreadOverlayState({ backend: watch.backend, threadId: watch.threadId });
        rows = this.canonicalizePrs(overlay?.prs ?? []);
        rowsByThread.set(threadKey, rows);
      }
      if (rows.some((pr) => getPrStatusKey(pr) === prKey)) continue;
      const renamed = rows.find((pr) =>
        isSameNumberInAnotherRepository(pr.url, this.prRepositoryAliases.canonicalizeUrl(watch.prUrl))
      );
      if (!renamed) continue;
      asked.add(watch.prUrl);
      await this.resolveCurrentPullRequestUrl(watch.prUrl, renamed.linkedDirectoryPaths?.[0]);
    }
  }

  /**
   * Project stored PR rows through the canonical status registry,
   * loading it from `pr_status_cache` first so this works even when no
   * window has driven a lookup yet. Injected into the backend registry,
   * which serves both thread inspection and the navigation snapshot the
   * federation/messaging bridge hands to remote viewers.
   */
  async canonicalizeStoredPullRequests(
    prs: PrSummary[],
    demand?: PrAttachmentDemand,
    verifyAttachments = true,
  ): Promise<PrSummary[]> {
    await this.loadPrStatusRegistry();
    const canonical = this.canonicalizePrs(prs);
    return verifyAttachments ? await this.filterStoredDiscoveredPrs(canonical, demand) : canonical;
  }

  private mergePrHistory(
    existingPrs: PrSummary[],
    discoveredPrs: PrSummary[],
  ): PrSummary[] {
    const merged = this.canonicalizePrs(existingPrs);
    const indexes = new Map<string, number>();
    merged.forEach((pr, index) => {
      indexes.set(getPrStatusKey(pr), index);
    });

    for (const pr of this.canonicalizePrs(discoveredPrs)) {
      const key = getPrStatusKey(pr);
      const existingIndex = indexes.get(key);
      if (existingIndex === undefined) {
        indexes.set(key, merged.length);
        merged.push(pr);
      } else {
        const existing = merged[existingIndex];
        merged[existingIndex] = normalizePrSummary({
          ...pr,
          linkedDirectoryPaths: mergeLinkedDirectoryPaths(
            existing?.linkedDirectoryPaths,
            pr.linkedDirectoryPaths,
          ),
          ...pullRequestAttachmentIntent(existing, pr),
        });
      }
    }

    return merged;
  }

  private seedPrStatusRegistryFromThreads(
    threads: NavigationSnapshot["threads"],
  ): void {
    for (const thread of threads) {
      if (!thread.prs?.length) {
        continue;
      }
      this.rememberPrStatuses(thread.prs, 0, "navigation-overlay");
    }
  }

  private applyCanonicalPrStatuses(
    threads: NavigationSnapshot["threads"],
  ): { threads: NavigationSnapshot["threads"]; changed: boolean } {
    let changed = false;
    const canonicalThreads = threads.map((thread) => {
      if (!thread.prs?.length) {
        return thread;
      }
      const prs = this.canonicalizePrs(thread.prs);
      if (prSummariesEqual(thread.prs, prs)) {
        return thread;
      }
      changed = true;
      return { ...thread, prs };
    });

    return { threads: canonicalThreads, changed };
  }

  private async publishThreadPullRequestsUpdated(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prs: PrSummary[];
    detachedPrs?: PrSummary[];
  }): Promise<void> {
    await this.rememberThreadPrAttachmentUpdate(params);
    const worktreePath = this.rememberPublishedPrCommitShasForThread({
      ...params,
      prs: [...params.prs, ...(params.detachedPrs ?? [])],
    });
    if (worktreePath) {
      getDesktopBackendRegistry().invalidateWorktreeWorkingState(worktreePath);
      void this.loadThreadGitWorkingStateCache().then(() => {
        this.startWorktreeWorkingStateRefresh({
          worktreePaths: [worktreePath],
          force: true,
        });
      });
    }
    await getDesktopBackendRegistry().publishLocalEvent({
      backend: params.backend,
      notification: {
        method: "thread/pullRequests/updated",
        params: {
          threadId: params.threadId,
          prs: params.prs,
        },
      },
    });
  }

  /**
   * A GitHub stack's member list arrived. Its members' rows project the stack
   * from it, so tell the windows showing them to read their stacks again.
   */
  private publishGithubForgeStackLearned(stack: GithubForgeStack): void {
    const members = new Set(stack.layers.map((layer) => layer.number));
    const byBackend = new Map<AppServerBackendKind, PrSummary[]>();
    for (const pr of this.knownStackPullRequests()) {
      if (!members.has(pr.number)
        || githubForgeStackRepository({ host: pr.provider, owner: pr.org, repo: pr.repo }) !== stack.repository) continue;
      for (const threadKey of this.findThreadKeysForPrKey(getPrStatusKey(pr))) {
        const backend = parseThreadIdentityKey(threadKey)?.backend;
        if (!backend) continue;
        const prs = byBackend.get(backend) ?? [];
        if (!prs.includes(pr)) prs.push(pr);
        byBackend.set(backend, prs);
      }
    }
    for (const [backend, prs] of byBackend) {
      void this.publishPullRequestStatusUpdates({ backend, prs }).catch((error: unknown) =>
        appServerLog.warn("could not publish a GitHub stack's members", {
          stack: stack.number, error: error instanceof Error ? error.message : String(error),
        }));
    }
  }

  private async publishPullRequestStatusUpdates(params: {
    backend: AppServerBackendKind;
    prs: PrSummary[];
    stackAlreadyObserved?: boolean;
  }): Promise<void> {
    // Persistence may have yielded to a newer status observation.
    const current = params.prs.flatMap((pr) => this.matchingPrStatus(pr)?.pr ?? []);
    // A poll evaluates the open layers and merged parents as one batch before
    // publishing its status events. Other status sources enter here.
    if (!params.stackAlreadyObserved) this.queueStackAdvance(current.filter((pr) => pr.lifecycleState === "merged"));
    await Promise.all(
      current.map(async (pr) => {
        const prKey = getPrStatusKey(pr);
        const aliases = this.prRepositoryAliases.equivalentStatusKeys(prKey);
        await getDesktopBackendRegistry().publishLocalEvent({
          backend: params.backend,
          ...(aliases.length ? { navigationPullRequestKeyAliases: aliases } : {}),
          notification: {
            method: "pullRequest/status/updated",
            params: {
              prKey,
              pr,
            },
          },
        });
      }),
    );
  }

  /**
   * Renderer tells us which threads are selected / on screen. Their PRs move to
   * the poller's fast tier; everything else backs off. Cheap and idempotent —
   * the renderer debounces, and this only swaps a Set. Each window's focus is
   * tracked under its webContents id so windows don't clobber each other.
   */
  setPullRequestPollingFocus(
    request: SetPullRequestPollingFocusRequest,
    senderKey = 0,
  ): void {
    this.prPollingFocus.set(senderKey, request.threadKeys);
    const now = Date.now();
    for (const key of request.threadKeys) {
      this.prDiscoveryAccessByThreadKey.set(key, Math.max(now, this.prDiscoveryAccessByThreadKey.get(key) ?? 0));
    }
  }

  /** Drop a closed window's focus so its threads leave the fast tier. */
  clearPullRequestPollingFocusForSender(senderKey: number): void {
    this.prPollingFocus.clearSender(senderKey);
  }

  setTranscriptPullRequests(
    request: SetTranscriptPullRequestsRequest,
    senderKey: number,
    publish: (statuses: TranscriptPullRequestStatuses) => void,
  ): TranscriptPullRequestStatuses {
    const snapshot = this.transcriptPrSubscriptions.set(senderKey, request, publish);
    this.transcriptPrSubscriptions.requestRefresh(this.refreshTranscriptPrTargets);
    return snapshot;
  }

  private readonly refreshTranscriptPrTargets = async (): Promise<void> => {
    await Promise.all([this.loadPrStatusRegistry(), this.threadPullRequestLookup.loadPrLookupRegistry()]);
    if (!this.transcriptPrSubscriptions.hasSubscribers) return;
    this.ensurePrPollingSchedulerStarted();
    await this.prPollingScheduler?.tick(this.pendingTranscriptPrTargets);
  };

  private readonly pendingTranscriptPrTargets = (): PrPollTarget[] =>
    this.transcriptPrSubscriptions.pendingTargets().map((target) => this.hydrateTranscriptPrTarget(target));

  private hydrateTranscriptPrTarget(target: PrPollTarget): PrPollTarget {
    const threadKey = this.primaryPrThreadsByKey.get(target.prKey)?.values().next().value;
    const attachment = threadKey ? this.attachedPrsByThreadKey.get(threadKey) : undefined;
    if (attachment) this.prPollBackendByKey.set(target.prKey, attachment.backend);
    const known = this.prStatusRegistry.get(target.prKey);
    if (known && known.fetchedAt > (target.fetchedAt ?? 0)) {
      this.transcriptPrSubscriptions.observe([known.pr], known.fetchedAt);
      return { ...target, pr: known.pr, fetchedAt: known.fetchedAt };
    }
    return target;
  }

  clearTranscriptPullRequestsForSender(senderKey: number): void {
    this.transcriptPrSubscriptions.clearSender(senderKey);
  }

  async probePullRequestPollingAfterReconnect(): Promise<void> {
    // Arm the shared client even when background polling is disabled or has no
    // eligible target; the next foreground lookup can consume the bypass.
    if (!this.getPrGraphqlClient().noteNetworkReconnect()) {
      return;
    }
    await this.prPollingScheduler?.probeAfterNetworkReconnect();
  }

  acknowledgeGithubPrAuthenticationNotice(): void {
    this.githubPrAuthenticationNotice.acknowledge();
  }

  /** PwrAgent set Git LFS up where the operator's own Git cannot push. */
  publishBundledGitLfsAdvisory(repositoryPath: string): void {
    const event = { occurredAt: Date.now(), repositoryPath };
    this.bundledGitLfsNotice.publish(
      subscribersForChannel(BUNDLED_GIT_LFS_ADVISORY_EVENT_CHANNEL)
        .filter((webContents) => !webContents.isDestroyed())
        .map((webContents) => () => webContents.send(
          BUNDLED_GIT_LFS_ADVISORY_EVENT_CHANNEL,
          event,
        )),
    );
  }

  acknowledgeBundledGitLfsAdvisory(): void {
    this.bundledGitLfsNotice.acknowledge();
  }

  /**
   * Repair stored automatic attachments. A renamed repository's remote can
   * still carry the old name, so a stored PR no remote names asks GitHub what
   * that remote is called now before it is dropped.
   */
  private async filterStoredDiscoveredPrs(prs: PrSummary[], demand?: PrAttachmentDemand): Promise<PrSummary[]> {
    return await filterStoredDiscoveredPullRequests(prs, {
      demand,
      resolveRepositoryNames: demand?.allowForgeLookup === false ? undefined : async (repos) => {
        if (!getDesktopSettingsService().isForgeEnabled("github")) return;
        await this.getPrGraphqlClient().resolveRepositoryNames(repos);
      },
    });
  }

  private getPrGraphqlClient(): GithubGraphqlPrClient {
    if (!this.prGraphqlClient) {
      this.prGraphqlClient = new GithubGraphqlPrClient({
        getConfiguredGhCommand: () =>
          getDesktopSettingsService().resolveGhCommandPreference(),
        onAuthenticationFailure: (event) => {
          const notice = {
            occurredAt: Date.now(),
            ...(event.detail ? { detail: event.detail } : {}),
          };
          this.githubPrAuthenticationNotice.publish(
            subscribersForChannel(GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL)
              .filter((webContents) => !webContents.isDestroyed())
              .map((webContents) => () => webContents.send(
                GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL,
                notice,
              )),
          );
        },
        onRepositoryAccess: (event) => {
          const target = {
            kind: "github-repository" as const,
            owner: event.owner,
            repo: event.repo,
          };
          const key = githubPrAccessTargetKey(target);
          if (event.status === "available") {
            this.githubSamlBlockedRepositories.delete(key);
            return;
          }
          if (this.githubSamlBlockedRepositories.has(key)) {
            return;
          }
          this.githubSamlBlockedRepositories.add(key);
          const notice = {
            branch: event.branch,
            occurredAt: Date.now(),
            target,
          };
          for (const webContents of subscribersForChannel(
            GITHUB_PR_SAML_ENFORCEMENT_EVENT_CHANNEL,
          )) {
            if (!webContents.isDestroyed()) {
              webContents.send(GITHUB_PR_SAML_ENFORCEMENT_EVENT_CHANNEL, notice);
            }
          }
        },
      });
    }
    return this.prGraphqlClient;
  }

  private async readPrAutoDispatchBudgetConfig(): Promise<PrAutoDispatchBudgetConfig> {
    return resolvePrAutomationConfig(getDesktopConfigStore().read("git")).budget;
  }

  /**
   * Start or stop background PR polling and automatic repair dispatch to match
   * the Git settings. Called at owner startup and after settings writes, so
   * both gates take effect independently of renderer navigation demand.
   */
  syncPrPollingSchedulerState(): void {
    const settingsSyncGeneration = ++this.prPollingSettingsSyncGeneration;
    void (async () => {
      let backgroundPollingEnabled = DEFAULT_BACKGROUND_PR_POLLING;
      let prAutoDispatchAllowed = DEFAULT_PR_AUTO_DISPATCH_ALLOWED;
      let budgetConfig: PrAutoDispatchBudgetConfig = {
        capacity: DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
        refillPerMinute: DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
        pauseWhenEmpty: DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
      };
      let budgetStatus: PrAutoDispatchBudgetStatus | undefined;
      try {
        // Owner startup establishes this subscription even when no renderer
        // opens a navigation collection.
        if (!this.prPollingSettingsUnsubscribe) {
          this.prPollingSettingsUnsubscribe = getDesktopConfigStore().subscribe(
            ["git"],
            () => {
              // Pause dispatch pessimistically while the new snapshot is read.
              // This closes settings-write races for both global kill switches.
              this.backgroundPrPollingEnabled = false;
              this.prAutoDispatchAllowed = false;
              this.prAutoDispatchCoordinator?.pause();
              this.syncPrPollingSchedulerState();
            },
          );
        }
        const config = resolvePrAutomationConfig(
          getDesktopConfigStore().read("git"),
        );
        backgroundPollingEnabled = config.backgroundPollingEnabled;
        prAutoDispatchAllowed = config.prAutoDispatchAllowed;
        budgetConfig = config.budget;
        budgetStatus = await this.getOverlayStore().peekPrAutoDispatchBudgetStatus({
          config: budgetConfig,
          now: Date.now(),
        });
      } catch (error) {
        appServerLog.warn("failed to read GitHub PR automation settings", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (settingsSyncGeneration !== this.prPollingSettingsSyncGeneration) {
        return;
      }

      this.backgroundPrPollingEnabled = backgroundPollingEnabled;
      // CI run and merge build waits are checked under the same switch as PR polling.
      this.threadDependencyCiRunPoller?.sync();
      this.threadDependencyMergeBuildPoller?.sync();
      this.ciApprovalPoller?.sync();
      this.prAutoDispatchAllowed = prAutoDispatchAllowed;
      this.prAutoDispatchBudgetConfig = budgetConfig;
      if (budgetStatus?.paused) {
        this.updatePrAutoDispatchBudgetStatus(budgetStatus);
      }

      if (!backgroundPollingEnabled) {
        this.prAutoDispatchCoordinator?.pause();
        this.stopPrPollingScheduler();
        return;
      }
      this.ensurePrPollingSchedulerStarted();
      if (!this.isPrAutoDispatchAvailable()) {
        this.prAutoDispatchCoordinator?.pause();
        return;
      }
      void this.getPrAutoDispatchCoordinator().resume();
    })();
  }

  private isPrAutoDispatchAvailable(): boolean {
    return (
      this.backgroundPrPollingEnabled
      && this.prAutoDispatchAllowed
      && !this.prAutoDispatchBudgetPaused
    );
  }

  private takePrPollingToken(source: string, prKeys: string[] = [], threadKeys: string[] = [], minimumRemaining = 0): boolean {
    const admitted = this.prStatusTokenBucket.tryTake(undefined, minimumRemaining);
    this.prActivity.record({
      category: "budget",
      budget: "polling",
      source,
      prKeys,
      threadKeys,
      delta: admitted ? -1 : 0,
      availableTokens: this.prStatusTokenBucket.availableTokens,
      ...(admitted ? {} : { tone: "warning" as const }),
      message: admitted ? "PR check allowed" : minimumRemaining > 0
        ? "PR check postponed: preserving foreground request budget"
        : "PR check postponed: request budget empty",
    });
    return admitted;
  }

  getPrActivity(): PrActivitySnapshot {
    return {
      ...this.prActivity.snapshot({
        threadTitle: (key) => {
          const identity = parseThreadIdentityKey(key);
          return identity ? getDesktopBackendRegistry().getCachedThreadSummary(identity)?.title : undefined;
        },
        prUrl: (key) => this.prStatusRegistry.get(key)?.pr.url,
      }),
      monitoring: {
        backgroundPollingEnabled: this.backgroundPrPollingEnabled,
        autoFixAllowed: this.prAutoDispatchAllowed,
        repairBudgetPaused: this.prAutoDispatchBudgetPaused,
        pollingBudget: {
          availableTokens: this.prStatusTokenBucket.peek(),
          capacity: PR_STATUS_TOKEN_BUCKET_CAPACITY,
          refillPerMinute: PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE,
        },
        repairBudget: {
          capacity: this.prAutoDispatchBudgetConfig.capacity,
          refillPerMinute: this.prAutoDispatchBudgetConfig.refillPerMinute,
        },
      },
    };
  }

  async getPrAutoDispatchBudgetStatus(): Promise<PrAutoDispatchBudgetStatus> {
    // The renderer requests this while mounting, before a navigation snapshot
    // necessarily synchronizes the cached config. Reading bucket status applies
    // refill durably, so it must use the profile settings rather than defaults.
    const budgetConfig = await this.readPrAutoDispatchBudgetConfig();
    this.prAutoDispatchBudgetConfig = budgetConfig;
    const status = await this.getOverlayStore().getPrAutoDispatchBudgetStatus({
      config: budgetConfig,
      now: Date.now(),
    });
    if (status.paused) {
      this.updatePrAutoDispatchBudgetStatus(status);
    }
    return status;
  }

  async resumePrAutoDispatchBudget(): Promise<PrAutoDispatchBudgetStatus> {
    const budgetConfig = await this.readPrAutoDispatchBudgetConfig();
    this.prAutoDispatchBudgetConfig = budgetConfig;
    const status = await this.getOverlayStore().resumePrAutoDispatchBudget({
      config: budgetConfig,
      now: Date.now(),
    });
    this.updatePrAutoDispatchBudgetStatus(status, { allowResume: true });
    if (this.isPrAutoDispatchAvailable()) {
      void this.getPrAutoDispatchCoordinator().resume();
    }
    return status;
  }

  private async refreshPrAutoDispatchBudgetSafetyStop(): Promise<void> {
    if (!this.prAutoDispatchBudgetPaused) return;
    try {
      const status = await this.getOverlayStore().peekPrAutoDispatchBudgetStatus({
        config: this.prAutoDispatchBudgetConfig,
        now: Date.now(),
      });
      if (status.paused) return;
      this.updatePrAutoDispatchBudgetStatus(status, { allowResume: true });
      if (this.isPrAutoDispatchAvailable()) {
        void this.getPrAutoDispatchCoordinator().resume();
      }
    } catch (error) {
      appServerLog.warn("failed to refresh automatic PR repair budget", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private updatePrAutoDispatchBudgetStatus(
    status: PrAutoDispatchBudgetStatus,
    options?: { allowResume?: boolean },
  ): void {
    const previousPaused = this.prAutoDispatchBudgetPaused;
    const previousPausedAt = this.prAutoDispatchBudgetPausedAt;
    if (status.paused) {
      this.prAutoDispatchBudgetPaused = true;
      this.prAutoDispatchBudgetPausedAt = status.pausedAt;
      this.prAutoDispatchCoordinator?.pause();
    } else if (options?.allowResume) {
      this.prAutoDispatchBudgetPaused = false;
      this.prAutoDispatchBudgetPausedAt = undefined;
    }
    const pauseStateChanged = previousPaused !== this.prAutoDispatchBudgetPaused;
    const pauseEventChanged =
      status.paused && status.pausedAt !== previousPausedAt;
    if (pauseStateChanged || pauseEventChanged) {
      this.broadcastPrAutoDispatchBudgetStatus(status);
    }
    if (pauseStateChanged) {
      // Auto-fix rows read "paused" from the PR watch list.
      void this.publishPrAutoFixStatesChanged().catch((error: unknown) => {
        appServerLog.warn("failed to publish Auto-fix state change", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private broadcastPrAutoDispatchBudgetStatus(
    status: PrAutoDispatchBudgetStatus,
  ): void {
    for (const webContents of subscribersForChannel(
      PR_AUTO_DISPATCH_BUDGET_CHANGED_EVENT_CHANNEL,
    )) {
      if (!webContents.isDestroyed()) {
        webContents.send(PR_AUTO_DISPATCH_BUDGET_CHANGED_EVENT_CHANNEL, status);
      }
    }
  }

  private stopPrPollingScheduler(): void {
    const wasRunning = this.prPollingScheduler !== undefined;
    if (this.prPollingScheduler) {
      this.prPollingScheduler.stop();
      this.prPollingScheduler = undefined;
    }
    if (this.prDiscoveryTimer) {
      clearInterval(this.prDiscoveryTimer);
      this.prDiscoveryTimer = undefined;
    }
    this.prDiscoveryLastRefreshedAt.clear();
    if (wasRunning) {
      // Info, not debug: an operator toggling the experimental flag should see
      // it take effect in the normal log without turning on debug collection.
      appServerLog.info("background PR polling disabled");
    }
  }

  /**
   * Boot the background poller once we have a navigation snapshot (and thus
   * thread→PR contexts to poll). Idempotent: called on every snapshot.
   */
  private ensurePrPollingSchedulerStarted(): void {
    this.ensurePrReviewOfferCoordinator();
    if (this.prPollingScheduler) {
      if (this.backgroundPrPollingEnabled && this.prStatusRegistryLoaded && this.threadPullRequestLookup.loaded) {
        this.prPollingScheduler.start();
        this.startPrDiscoveryRefresh();
      }
      return;
    }
    appServerLog.debug("creating PR polling scheduler");
    const scheduler = new PrPollingScheduler({
      listTargets: () => this.collectPrPollTargets(),
      getFocusedThreadKeys: () => this.prPollingFocus.union(),
      isWindowVisible: () =>
        getOwnerHostServices().ui.isWindowVisible(),
      // GitLab takes this token when its first request actually starts.
      onPollUnavailable: (targets, failed) => {
        for (const target of targets) this.prActivity.record({
          category: "check", source: "background poll", threadKeys: target.threadKeys, prKeys: [target.prKey],
          tone: failed ? "error" : "warning",
          message: failed ? "PR check failed; retry on next poll" : "No fresh status returned; provider may be unavailable or cooling down",
        });
      },
      tryTakeToken: (targets = []) => this.takePrPollingToken("background poll", targets.map((t) => t.prKey), targets.flatMap((t) => t.threadKeys)),
      fetchPullRequests: async (refs, gitlabPoll) =>
        await this.fetchForgePullRequests(refs, { gitlabPoll }),
      fetchPullRequestsAfterReconnect: async (refs, gitlabPoll) =>
        await this.fetchForgePullRequests(refs, { reconnect: true, gitlabPoll }),
      getObservationTimestamp: () => this.nextPrObservationTimestamp(),
      onTargetsHandled: (keys) => this.transcriptPrSubscriptions.markHandled(keys),
      applyResults: async (prs, fetchedAt, fetchedAtByKey) => {
        // Mention-only results must never enter persistence, transitions, or
        // automatic repair. The registry supplies the status for attached PRs.
        const attached: PrSummary[] = [];
        const mentions: PrSummary[] = [];
        for (const pr of prs) {
          (this.primaryPrThreadsByKey.has(getPrStatusKey(pr)) ? attached : mentions).push(pr);
        }
        if (!attached.length) {
          this.transcriptPrSubscriptions.observe(mentions, fetchedAt, fetchedAtByKey);
          return [];
        }
        return await this.applyPolledPrStatuses(attached, fetchedAt, fetchedAtByKey, mentions);
      },
    });
    this.prPollingScheduler = scheduler;

    // The registries are lazily hydrated from sqlite; polling before they load
    // would see an empty target list and idle for a tick.
    void Promise.all([this.loadPrStatusRegistry(), this.threadPullRequestLookup.loadPrLookupRegistry()])
      .then(() => {
        // A late toggle-off could have torn the scheduler down while the
        // registries were still loading; don't resurrect it.
        if (this.prPollingScheduler !== scheduler) {
          return;
        }
        if (!this.backgroundPrPollingEnabled) return;
        scheduler.start();
        this.startPrDiscoveryRefresh();
        appServerLog.info("background PR polling started", {
          trackedPrCount: this.collectPrPollTargets().length,
        });
        void this.retryPendingPrTerminalWatches()
          .then(() => this.resolveRenamedPrWatchRepositories())
          .catch((error) => {
            appServerLog.warn("pr watch repository resolve failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .then(() => this.retryPendingPrTerminalWatches())
          .catch((error) => {
            appServerLog.warn("pr terminal watch startup retry failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        void this.retryPendingSandboxCleanups().catch((error) => {
          appServerLog.warn("sandboxer cleanup startup retry failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      })
      .catch((error) => {
        appServerLog.warn("failed to start PR polling scheduler", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * Start the slow discovery rotation (Layer B). Idempotent. See
   * `pr-discovery.ts` for why this re-runs the branch lookup rather than a
   * search/`since` crawl.
   */
  private startPrDiscoveryRefresh(): void {
    if (this.prDiscoveryTimer) {
      return;
    }
    this.prDiscoveryTimer = setInterval(() => {
      this.runPrDiscoveryTick();
    }, PR_DISCOVERY_TICK_INTERVAL_MS);
    // Discovery must never hold the process open.
    this.prDiscoveryTimer.unref?.();
  }

  private runPrDiscoveryTick(): void {
    // Discovery is a background nicety; skip it entirely while hidden rather
    // than spend `gh` subprocesses and tokens no one will see.
    const visible = getOwnerHostServices().ui.isWindowVisible();
    if (!visible) {
      return;
    }

    const now = Date.now();
    const threadKeys = [...this.prRefreshContextByThreadKey.keys()];
    this.prunePrDiscoveryState(threadKeys);

    const due = selectDiscoveryDueThreadKeys({
      // A paused project discovers no PRs; its clocks are kept for resume.
      threadKeys: selectRecentPrDiscoveryThreads(
        threadKeys.filter((threadKey) => projectAllowsForgePolling(this.threadKeyForgeAutomation(threadKey))),
        this.prDiscoveryAccessByThreadKey,
        now,
      ),
      lastRefreshedAt: this.prDiscoveryLastRefreshedAt,
      now,
      cadenceMs: PR_DISCOVERY_CADENCE_MS,
      maxPerTick: PR_DISCOVERY_MAX_PER_TICK,
      // The selected / on-screen threads already get a fast branch-lookup from
      // the renderer — re-doing it here would just burn budget.
      skipThreadKeys: this.prPollingFocus.union(),
    });

    const dueContexts: ThreadPrRefreshContext[] = [];
    for (const threadKey of due) {
      // Mark before firing so a slow refresh cannot keep re-selecting the same
      // thread on the next tick.
      this.prDiscoveryLastRefreshedAt.set(threadKey, now);
      dueContexts.push(...(this.prRefreshContextByThreadKey.get(threadKey) ?? []));
    }
    if (dueContexts.length === 0) {
      return;
    }

    // Answer every due branch lookup in one batched in-process request, then
    // let the normal refresh path consume those answers. Anything not primed
    // gets a fresh in-process request through the normal refresh path.
    void this.primeDiscoveryBranchLookups(dueContexts)
      .catch((error) => {
        appServerLog.debug("pr discovery prefetch failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.startDiscoveryRefreshes(dueContexts);
      });
  }

  /**
   * Resolve each due (directory, branch) to a GitHub repo and look them all up
   * in one batched GraphQL request, priming the fetcher with the results.
   *
   * This keeps discovery to one batched request instead of one request per
   * branch. Only directory/branch pairs whose every configured GitHub repo
   * answered are primed; a missing answer is not recorded as "no PRs".
   */
  private async primeDiscoveryBranchLookups(
    contexts: ThreadPrRefreshContext[],
  ): Promise<void> {
    if (!this.getPrFetcher().isProviderEnabled("github")) return;
    const resolvePrefetchRepos = createScheduledPrPrefetchRepoResolver();
    const candidates: { cwd: string; branch: string }[] = [];
    const branchesByCheckout = new Map<string, Set<string>>();
    for (const context of contexts) {
      const branch = context.branch.trim();
      // "HEAD" contexts are not branch lookups, and the detection path skips
      // default branches entirely — priming either would be wasted work.
      if (!branch || branch === "HEAD") {
        continue;
      }
      for (const cwd of context.directoryPaths) {
        const branches = branchesByCheckout.get(cwd) ?? new Set<string>();
        if (branches.has(branch)) continue;
        branches.add(branch);
        branchesByCheckout.set(cwd, branches);
        candidates.push({ cwd, branch });
      }
    }

    const entries: { cwd: string; branch: string; repos: GitHubRepoRef[]; refs: BranchRef[] }[] = [];
    for (const { cwd, branch } of candidates) {
      const branchCount = branchesByCheckout.get(cwd)!.size;
      const repos = branchCount > 1
        ? await resolvePrefetchRepos(cwd, branch, branchCount)
        : await resolveScheduledPrPrefetchRepos(cwd, branch);
      if (repos.length === 0) continue;
      entries.push({
        cwd,
        branch,
        repos,
        refs: repos.map(({ owner, repo }) => ({ owner, repo, branch })),
      });
    }
    if (entries.length === 0) {
      return;
    }

    const refs = entries.flatMap((entry) => entry.refs);
    const byRefKey = await this.getPrGraphqlClient().fetchPullRequestsForBranches(
      refs,
    );
    const primed = entries
      .map((entry) => {
        const answers = entry.refs.map((ref) => byRefKey.get(branchRefKey(ref)));
        return {
          cwd: entry.cwd,
          branch: entry.branch,
          repos: entry.repos,
          prs: answers.some((answer) => answer === undefined)
            ? undefined
            : dedupePrsByStatusKey(answers.flatMap((answer) => answer ?? [])),
        };
      })
      .filter(
        (entry): entry is { cwd: string; branch: string; repos: GitHubRepoRef[]; prs: PrSummary[] } =>
          entry.prs !== undefined,
      );
    if (primed.length === 0) {
      return;
    }
    this.getPrFetcher().github.primeBranchLookup(primed);
    appServerLog.debug("pr discovery primed branch lookups", {
      requested: refs.length,
      primed: primed.length,
    });
  }

  private startDiscoveryRefreshes(contexts: ThreadPrRefreshContext[]): void {
    for (const context of contexts) {
      // `trigger: "scheduled"` routes through the existing per-lookup cooldown
      // and the shared token bucket, so discovery self-limits against the
      // fast poller and the terminal short-circuit still applies.
      void this.refreshThreadPullRequests({
        backend: context.backend,
        threadId: context.threadId,
        provider: DEFAULT_PULL_REQUEST_PROVIDER,
        trigger: "scheduled",
        branch: context.branch,
        directoryPaths: context.directoryPaths,
      }).catch((error) => {
        appServerLog.debug("pr discovery refresh failed", {
          threadId: context.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private prunePrDiscoveryState(threadKeys: string[]): void {
    if (this.prDiscoveryLastRefreshedAt.size === 0) {
      return;
    }
    const live = new Set(threadKeys);
    for (const threadKey of this.prDiscoveryLastRefreshedAt.keys()) {
      if (!live.has(threadKey)) {
        this.prDiscoveryLastRefreshedAt.delete(threadKey);
      }
    }
  }

  /**
   * Every tracked, non-terminal PR the poller should keep fresh, with the
   * threads that display it.
   *
   * Uses the owner attachment set populated at startup/provider completion and
   * attachment events. This includes explicit PRs on directoryless threads
   * and excludes detached PRs even though lookup history retains them for
   * non-UI bookkeeping.
   */
  private collectPrPollTargets(): PrPollTarget[] {
    const byKey = new Map<string, PrPollTarget>();
    this.prPollBackendByKey.clear();

    for (const [threadKey, attachment] of this.attachedPrsByThreadKey) {
      if (!this.backgroundPrPollingEnabled) break;
      // A paused project's PRs are not polled; their chips keep the last
      // status. Another project's thread on the same PR still polls it.
      if (!projectAllowsForgePolling(this.threadKeyForgeAutomation(threadKey))) continue;
      for (const pr of attachment.prs.filter((candidate) =>
        this.matchesPrimaryRepository(candidate, attachment.primaryRepoKey)
      )) {
        const prKey = getPrStatusKey(pr);
        const status = this.prStatusRegistry.get(prKey);
        const latest = status?.pr ?? pr;
        if (isTerminalPullRequest(latest)) continue;
        this.prPollBackendByKey.set(prKey, attachment.backend);
        const existing = byKey.get(prKey);
        if (existing) {
          if (!existing.threadKeys.includes(threadKey)) {
            existing.threadKeys.push(threadKey);
          }
          continue;
        }
        // A lookup that fetched this PR, or is fetching it, counts as a poll.
        // Without it, selecting a thread fetched each of its PRs twice: once
        // for the renderer's lookup and once for the poller's focused tier.
        const fetchedAt = Math.max(
          status?.fetchedAt ?? 0,
          this.threadPullRequestLookup.startedAt(prKey) ?? 0,
        );
        byKey.set(prKey, {
          prKey,
          pr: latest,
          threadKeys: [threadKey],
          ...(fetchedAt > 0 ? { fetchedAt } : {}),
        });
      }
    }
    for (const candidate of this.transcriptPrSubscriptions.targets()) {
      const target = this.hydrateTranscriptPrTarget(candidate);
      const existing = byKey.get(target.prKey);
      const fetchedAt = Math.max(existing?.fetchedAt ?? 0, target.fetchedAt ?? 0);
      byKey.set(target.prKey, existing ? {
        ...existing,
        subscriptionTier: target.subscriptionTier,
        ...(fetchedAt > 0 ? { fetchedAt } : {}),
      } : target);
    }
    return [...byKey.values()];
  }

  /**
   * The stored Forge Automation of a thread's project, from the in-memory
   * index. The registry is read only for a thread the last navigation scan
   * did not list, and only while some project stores a setting.
   */
  private threadForgeAutomation(ref: {
    backend: AppServerBackendKind;
    threadId: string;
  }): ProjectForgeAutomation | undefined {
    return getProjectForgeAutomationIndex().automationForThread(
      ref,
      () => getDesktopBackendRegistry().getCachedThreadSummary(ref),
    );
  }

  /**
   * The hands-off rule in the thread's project that leaves this PR to its
   * maintainers, read against the registry's latest status (its labels).
   */
  private prHandsOff(
    ref: { backend: AppServerBackendKind; threadId: string },
    pr: PrSummary,
  ): HandsOffMatch | undefined {
    const automation = this.threadForgeAutomation(ref);
    if (!automation?.handsOff) return undefined;
    return findHandsOffMatch(automation, this.prStatusRegistry.get(getPrStatusKey(pr))?.pr ?? pr);
  }

  private threadKeyForgeAutomation(threadKey: string): ProjectForgeAutomation | undefined {
    if (!getProjectForgeAutomationIndex().hasAny()) return undefined;
    const identity = parseThreadIdentityKey(threadKey);
    return identity ? this.threadForgeAutomation(identity) : undefined;
  }

  /**
   * The refusal for a merge of `pr` in the thread's project when its Forge
   * Automation never merges into the PR's base; undefined when it merges.
   * Without a PR, or with a base not read yet, a never-merge project refuses.
   */
  private projectNeverMergeRefusal(
    ref: { backend: AppServerBackendKind; threadId: string },
    pr?: { number: number; baseRefName?: string },
  ): string | undefined {
    const project = this.resolveThreadForgeProject(ref);
    if (!project || projectMergesPullRequest(project.automation, pr?.baseRefName)) return undefined;
    const mergeBranches = projectMergeBranches(project.automation);
    return buildProjectNeverMergeRefusal({
      projectLabel: project.label,
      ...(pr ? { pullRequest: `#${pr.number}` } : {}),
      ...(mergeBranches.length ? { mergeBranches } : {}),
      ...(pr && !pr.baseRefName?.trim() ? { baseUnknown: true } : {}),
    });
  }

  /**
   * The Directories project a thread files under, whether or not it stores
   * a Forge Automation setting (`resolveThreadForgeProject` needs one).
   */
  private threadForgeDirectoryKey(ref: { backend: AppServerBackendKind; threadId: string }): string | undefined {
    const thread = { backend: ref.backend, threadId: ref.threadId };
    return getProjectForgeAutomationIndex().directoryKeyForThread(
      thread,
      () => getDesktopBackendRegistry().getCachedThreadSummary(thread),
    );
  }

  private resolveThreadForgeProject(ref: {
    backend: AppServerBackendKind;
    threadId: string;
  }): ProjectForgeAutomationResolution | undefined {
    return getProjectForgeAutomationIndex().resolveThread(
      ref,
      () => getDesktopBackendRegistry().getCachedThreadSummary(ref),
    );
  }

  private recordPrCheck(
    prs: PrSummary[],
    source: string,
    incomplete = false,
    requestingThreadKeys: string[] = [],
  ): void {
    for (const pr of prs) {
      const prKey = getPrStatusKey(pr);
      const threadKeys = [...new Set([
        ...(this.primaryPrThreadsByKey.get(prKey) ?? []),
        ...requestingThreadKeys,
      ])];
      this.prActivity.record({
        category: "check",
        source,
        threadKeys,
        prKeys: [prKey],
        tone: prCheckTone(pr),
        message: describePrCheck(pr, incomplete),
      });
    }
  }

  /**
   * The thread that owns Auto-fix for a PR. A project switch narrows only its
   * own threads, so the oldest thread whose project allows one of the PR's
   * current incidents wins. When none does, the plain winner stands and its
   * outcome reports the project setting.
   */
  private async getPrAutoDispatchWinner(pr: PrSummary, prKey: string) {
    const store = this.getOverlayStore();
    const eventKinds = getPrAutoDispatchEventKinds(pr);
    const hasProjectRules = getProjectForgeAutomationIndex().hasAny();
    const validate = this.isPrAutoDispatchAvailable() && Boolean(pr.headSha) && eventKinds.length > 0;
    if (eventKinds.length === 0 || (!validate && !hasProjectRules)) {
      return await store.getPrAutoDispatchCandidateWinner({ prKey });
    }
    // A thread whose project leaves this PR hands-off cannot claim it ahead
    // of a thread in a project that repairs it.
    const allowsRepair = (candidate: { backend: AppServerBackendKind; threadId: string }) => {
      const automation = this.threadForgeAutomation(candidate);
      return eventKinds.some((kind) => projectAllowsAutoFixKind(automation, kind))
        && !(automation?.handsOff && findHandsOffMatch(automation, pr));
    };
    const winner = await store.getPrAutoDispatchCandidateWinner({
      prKey,
      accepts: (candidate) => allowsRepair(candidate)
        && (!validate || this.isPrimaryPrAttached({ ...candidate, prKey }, false)),
    });
    if (winner) return winner;
    // A project-blocked candidate can still report the gate and cancel a
    // pending repair. It cannot claim the same incident ahead of a valid one.
    return hasProjectRules ? await store.getPrAutoDispatchCandidateWinner({
      prKey, accepts: (candidate) => !allowsRepair(candidate),
    }) : undefined;
  }

  private async handlePrAutoDispatchSnapshots(
    prs: PrSummary[],
    observedAt: number,
    operatorInitiated = false,
    fetchedAtByKey?: ReadonlyMap<string, number>,
  ): Promise<void> {
    await this.refreshPrAutoDispatchBudgetSafetyStop();
    const coordinator = this.getPrAutoDispatchCoordinator();
    for (const pr of prs) {
      const prKey = getPrStatusKey(pr);
      const prObservedAt = fetchedAtByKey?.get(prKey) ?? observedAt;
      const winner = await this.getPrAutoDispatchWinner(pr, prKey);
      const threadKeys = winner
        ? [buildThreadIdentityKey(winner.backend, winner.threadId)]
        : [];
      const outcomes = threadKeys.length > 0
        ? await coordinator.handleStatusSnapshot({
            pr,
            threadKeys,
            observedAt: prObservedAt,
            backgroundPollingEnabled: this.isPrAutoDispatchAvailable(),
            operatorInitiated,
          })
        : [];
      if (!winner) {
        this.prActivity.record({
          category: "repair",
          source: "Auto-fix",
          prKeys: [prKey],
          threadKeys: [...(this.primaryPrThreadsByKey.get(prKey) ?? [])],
          tone: "warning",
          message: "Not scheduled: no eligible thread owns Auto-fix for this PR",
        });
      }
      for (const outcome of outcomes) {
        const budgetBlocked = outcome.status === "gate-off" && this.prAutoDispatchBudgetPaused;
        const reason = outcome.status === "gate-off"
          ? budgetBlocked ? "Repair blocked: budget paused"
            : !this.backgroundPrPollingEnabled ? "Background polling is off" : "Auto-fix is disabled globally"
          : outcome.stackHold ?? describePrRepairDecision(outcome.status);
        this.prActivity.record({
          category: budgetBlocked ? "budget" : "repair",
          source: "Auto-fix",
          prKeys: [prKey],
          threadKeys: [outcome.threadKey],
          tone: prRepairDecisionTone(outcome.status),
          message: reason,
          ...(budgetBlocked ? { budget: "repair" as const, delta: 0 } : {}),
        });
        logPrAutoDispatchOutcome(appServerLog, prKey, outcome);
      }
      // Every thread showing this PR is in a project whose PR watches are
      // off: skip the claim-and-release a watch would cost on each poll.
      const watchThreadKeys = this.primaryPrThreadsByKey.get(prKey);
      const watchesHeld = Boolean(watchThreadKeys?.size)
        && [...watchThreadKeys!].every((threadKey) =>
          !projectAllowsPrWatches(this.threadKeyForgeAutomation(threadKey))
        );
      if (this.backgroundPrPollingEnabled && !watchesHeld) {
        const failureCoveredThreadKeys = new Set(
          outcomes.flatMap((outcome) =>
            outcome.status === "scheduled"
            || outcome.status === "pending"
              ? [outcome.threadKey]
              : [],
          ),
        );
        const dispatched = await this.getPrStatusWatchCoordinator()
          .handleStatusSnapshot(pr, prObservedAt, failureCoveredThreadKeys);
        if (dispatched > 0) {
          appServerLog.info("pr status watch completed", {
            prKey,
            watchCount: dispatched,
          });
        }
      }
      if (isTerminalPullRequest(pr)) {
        this.startSandboxCleanupForPr(prKey);
      }
    }
  }

  /**
   * A PR reached merged or closed: release the sandboxes of each thread it is
   * attached to, once all of that thread's PRs are terminal. Never awaited by
   * the poll; a merge/close wake waits for it separately, with a bound.
   */
  private startSandboxCleanupForPr(prKey: string): void {
    for (const [threadKey, attachment] of this.attachedPrsByThreadKey) {
      if (!attachment.prs.some((candidate) => getPrStatusKey(candidate) === prKey)) continue;
      const identity = parseThreadIdentityKey(threadKey);
      if (!identity) continue;
      void this.cleanupThreadSandboxesIfDone(identity.backend, identity.threadId)
        .catch((error) => appServerLog.warn("sandboxer cleanup failed", {
          threadKey,
          error: error instanceof Error ? error.message : String(error),
        }));
    }
  }

  /**
   * Release the Sandboxer sandboxes this thread created, but only once every
   * PR attached to it has merged or closed. A thread with several PRs may
   * still be testing the open ones, and a thread with no attached PR has
   * nothing to say its work is done, so neither is touched. Detached PRs do
   * not count.
   */
  private async cleanupThreadSandboxesIfDone(
    backend: AppServerBackendKind,
    threadId: string,
  ): Promise<SandboxCleanupReport | undefined> {
    const service = this.getSandboxerPrCleanup();
    if (!service) return undefined;
    const threadKey = buildThreadIdentityKey(backend, threadId);
    const attachment = this.attachedPrsByThreadKey.get(threadKey);
    if (!attachment || !this.canonicalizePrs(attachment.prs).some(isTerminalPullRequest)) return undefined;
    // Cached membership can nominate a thread for cleanup. Verify its
    // automatic attachments and abandon the decision if membership changed.
    const prs = await this.canonicalizeStoredPullRequests(attachment.prs);
    if (this.attachedPrsByThreadKey.get(threadKey) !== attachment
      || prs.length === 0 || !prs.every(isTerminalPullRequest)) return undefined;
    // A sandbox created after the last PR closed is for later work on this
    // thread. Without a forge timestamp, everything recorded so far counts.
    const closedAt = prs.map((pr) => pr.mergedAt ?? pr.closedAt);
    const createdBefore = closedAt.every((value) => typeof value === "number")
      ? Math.max(...(closedAt as number[]))
      : undefined;
    return await service.cleanupThread({
      backend,
      threadId,
      ...(createdBefore !== undefined ? { createdBefore } : {}),
    });
  }

  /** Startup: threads whose PRs all closed while a cleanup was pending. */
  private async retryPendingSandboxCleanups(): Promise<void> {
    const service = this.getSandboxerPrCleanup();
    if (!service) return;
    const pendingThreadIds = new Set(service.threadIdsWithPending());
    if (pendingThreadIds.size === 0) return;
    await this.loadPrStatusRegistry();
    for (const threadKey of this.attachedPrsByThreadKey.keys()) {
      const identity = parseThreadIdentityKey(threadKey);
      if (!identity || !pendingThreadIds.has(identity.threadId)) continue;
      await this.cleanupThreadSandboxesIfDone(identity.backend, identity.threadId);
    }
  }

  private getSandboxerPrCleanup(): SandboxerPrCleanupService | undefined {
    if (!getAppStateMode()) return undefined;
    if (!this.sandboxerPrCleanup) {
      const store = createThreadSandboxStorage();
      this.sandboxerPrCleanup = new SandboxerPrCleanupService({
        store,
        openTransport: async (params) =>
          await getMcpConnectionGatewayService().openPwrAgentToolSession({
            connectionId: params.connectionId,
            scopeKey: JSON.stringify([
              "pwragent-cleanup",
              params.backend,
              params.threadId,
            ]),
            signal: params.signal,
          }),
        isEnabled: (connectionId) =>
          getMcpConnectionGatewayService().isSandboxCleanupOnPrCloseEnabled(connectionId),
        onReport: (report) => this.recordSandboxCleanup(report),
      });
    }
    return this.sandboxerPrCleanup;
  }

  private recordSandboxCleanup(report: SandboxCleanupReport): void {
    if (report.entries.length === 0) return;
    const threadKey = buildThreadIdentityKey(
      report.backend as AppServerBackendKind,
      report.threadId,
    );
    const prKeys = (this.attachedPrsByThreadKey.get(threadKey)?.prs ?? [])
      .map((pr) => getPrStatusKey(pr));
    const failed = report.entries.some((entry) => entry.action === "failed");
    const skipped = report.entries.every((entry) => entry.action === "skipped");
    this.prActivity.record({
      category: "cleanup",
      source: "Sandboxer cleanup",
      threadKeys: [threadKey],
      prKeys,
      tone: failed ? "error" : skipped ? "warning" : "ok",
      message: report.entries.map((entry) =>
        `${entry.sandboxId}: ${entry.action}${entry.detail ? ` (${entry.detail})` : ""}`
      ).join("; "),
    });
    appServerLog.info("sandboxer cleanup", {
      threadKey,
      summary: summarizeSandboxCleanup(report),
      sandboxes: report.entries.map((entry) => ({
        sandboxId: entry.sandboxId,
        action: entry.action,
      })),
    });
  }

  async handleThreadPrAutoDispatchPreference(
    request: ThreadPrAutoDispatchPreferenceChange,
  ): Promise<void> {
    await this.handleThreadPrAutoDispatchPreferences([request]);
  }

  /**
   * Coalesce an operator's bulk preference change before reading provider
   * state. Several threads can attach the same PR; evaluating the final
   * candidate set once keeps the first eligible thread authoritative and
   * avoids a GraphQL request per thread.
   */
  async handleThreadPrAutoDispatchPreferences(
    requests: ThreadPrAutoDispatchPreferenceChange[],
  ): Promise<void> {
    if (requests.length === 0) {
      return;
    }
    try {
      await this.applyThreadPrAutoDispatchPreferences(requests);
    } finally {
      // A toggle can move the election to or from another thread, so every
      // window re-lists the Auto-fix rows.
      await this.publishPrWatchesUpdated(requests);
    }
  }

  /**
   * A lock hands the thread's PRs to another agent, so the thread leaves the
   * Auto-fix election as if its PRs were not attached, and its pending repair
   * is cancelled. The next eligible thread is elected now rather than at the
   * next poll. An unlock re-enters the election behind the threads that hold
   * the PRs by then, so it never takes a repair back from the agent that
   * picked it up. The lock has already landed when this runs, so a failure
   * here is logged rather than failing the lock; the next poll re-elects.
   */
  async handleThreadLockChanged(request: {
    backend: AppServerBackendKind;
    threadId: string;
    locked: boolean;
  }): Promise<void> {
    try {
      await this.applyThreadLockToPrAutoDispatch(request);
    } catch (error) {
      appServerLog.warn("failed to move Auto-fix after a thread lock change", {
        threadKey: buildThreadIdentityKey(request.backend, request.threadId),
        locked: request.locked,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async applyThreadLockToPrAutoDispatch(request: {
    backend: AppServerBackendKind;
    threadId: string;
    locked: boolean;
  }): Promise<void> {
    const identity = { backend: request.backend, threadId: request.threadId };
    if (request.locked) {
      await this.getPrAutoDispatchCoordinator().cancelAllPendingForThread(identity);
    }
    const changes = await this.syncThreadPrAutoDispatchCandidates(identity);
    if (changes.length === 0 || !this.isPrAutoDispatchAvailable()) return;
    const attachment = this.attachedPrsByThreadKey.get(
      buildThreadIdentityKey(request.backend, request.threadId),
    );
    const changedPrKeys = new Set(changes.map((change) => change.prKey));
    const prs = this.canonicalizePrs(attachment?.prs ?? [])
      .filter((pr) => changedPrKeys.has(getPrStatusKey(pr)));
    if (prs.length === 0) return;
    // Not operator-initiated: a repair the operator cancelled on the newly
    // elected thread stays cancelled.
    await this.handlePrAutoDispatchSnapshots(
      dedupePrsByStatusKey(prs),
      this.nextPrObservationTimestamp(),
    );
  }

  private async applyThreadPrAutoDispatchPreferences(
    requests: ThreadPrAutoDispatchPreferenceChange[],
  ): Promise<void> {

    const coordinator = this.getPrAutoDispatchCoordinator();
    const disabledRequests = requests.filter((request) => !request.enabled);
    const enabledRequests = requests.filter((request) => request.enabled);

    const previouslyEligiblePrs: PrSummary[] = [];
    for (const request of disabledRequests) {
      const attachment = this.attachedPrsByThreadKey.get(
        buildThreadIdentityKey(request.backend, request.threadId),
      );
      // Only a thread that was on hands its PRs to the next eligible thread.
      // That election is operator-initiated, so a repeated `enabled: false`
      // must not run it: it would re-arm a repair the operator cancelled on
      // the thread that wins.
      if (request.previouslyEnabled) {
        previouslyEligiblePrs.push(
          ...(attachment?.prs ?? []).filter((pr) =>
            this.matchesPrimaryRepository(pr, attachment?.primaryRepoKey),
          ),
        );
      }
      await coordinator.cancelAllPendingForThread(request);
      await this.syncThreadPrAutoDispatchCandidates(request);
    }
    if (this.isPrAutoDispatchAvailable() && previouslyEligiblePrs.length > 0) {
      await this.handlePrAutoDispatchSnapshots(
        dedupePrsByStatusKey(previouslyEligiblePrs),
        this.nextPrObservationTimestamp(),
        true,
      );
    }

    if (enabledRequests.length === 0) {
      return;
    }

    const primaryPrs: PrSummary[] = [];
    for (const request of enabledRequests) {
      const { prs } = await this.readPrimaryAttachedPrs(request);
      await this.syncThreadPrAutoDispatchCandidates(request);
      // Only an off -> on change refills the incident's attempts. A repeated
      // `enabled: true` must not, or each one buys another round of repairs.
      await coordinator.resetIfTurnedOn(request);
      primaryPrs.push(...prs);
    }
    if (!this.isPrAutoDispatchAvailable()) {
      return;
    }

    // Re-arming a repair the operator cancelled is for a request that turned
    // Auto-fix on, not one that repeated the current setting.
    const operatorInitiated = enabledRequests.some(isPrAutoDispatchTurnedOn);
    const uniquePrimaryPrs = dedupePrsByStatusKey(primaryPrs);
    await this.handlePrAutoDispatchSnapshots(
      uniquePrimaryPrs,
      this.nextPrObservationTimestamp(),
      operatorInitiated,
    );

    const refs = [
      ...new Map(
        uniquePrimaryPrs.flatMap((pr) => {
          const ref = parsePrRefFromUrl(pr.url);
          return ref ? [[`${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`, ref] as const] : [];
        }),
      ).values(),
    ];
    if (refs.length === 0) {
      return;
    }
    const refreshed = await this.fetchForgePullRequests(refs);
    if (refreshed.length === 0) {
      return;
    }
    const fetchedAt = this.nextPrObservationTimestamp();
    const { accepted, changed } = this.rememberPrStatuses(
      refreshed,
      fetchedAt,
      "auto-fix-enable",
    );
    await this.writePrStatusesToCache(accepted, fetchedAt);
    await this.publishPullRequestStatusUpdates({
      backend: enabledRequests[0]!.backend,
      prs: changed,
    });
    await this.handlePrAutoDispatchSnapshots(
      accepted,
      fetchedAt,
      operatorInitiated,
    );
  }

  /**
   * The Settings bulk action refreshes the complete attachment view before it
   * decides which saved preferences to change. Detached and informational PR
   * links are never eligible because primary-workspace matching happens here
   * in the main process.
   */
  async setEligibleThreadsPrAutoDispatch(
    request: SetEligibleThreadsPrAutoDispatchRequest,
  ): Promise<SetEligibleThreadsPrAutoDispatchResponse> {
    const index = await loadLocalNavigationQueryIndex({
      backend: "all",
      callerReason: "settings-bulk-pr-auto-dispatch",
      requireVerifiedDirectories: true,
    });
    if (index.coverage && index.coverage.state !== "complete") {
      throw new Error("Thread discovery is incomplete. Wait for providers to finish loading before changing Auto-fix for all eligible threads.");
    }
    await this.loadPrStatusRegistry();
    await this.threadPullRequestLookup.loadPrLookupRegistry();
    const verified = await getDesktopBackendRegistry().canonicalizeNavigationThreadPullRequests(index.threads);
    this.seedPrStatusRegistryFromThreads(verified);
    const canonical = this.applyCanonicalPrStatuses(verified);
    await this.rememberThreadPrAttachments(canonical.threads, { replace: true });
    const eligibleThreads = canonical.threads.filter((thread) => {
      const attachment = this.attachedPrsByThreadKey.get(
        buildThreadIdentityKey(thread.source, thread.id),
      );
      return Boolean(
        attachment?.primaryRepoKey
        && attachment.prs.some((pr) =>
          this.matchesPrimaryRepository(pr, attachment.primaryRepoKey)
          && !isTerminalPullRequest(pr)
        ),
      );
    });
    const updates = eligibleThreads
      .filter((thread) => thread.prAutoDispatchEnabled !== request.enabled)
      .map((thread) => ({
        backend: thread.source,
        threadId: thread.id,
        enabled: request.enabled,
      }));

    if (!request.dryRun && updates.length > 0) {
      await getDesktopBackendRegistry().setThreadPrAutoDispatchBatch(updates);
    }

    return {
      enabled: request.enabled,
      eligibleThreadCount: eligibleThreads.length,
      updatedThreadCount: updates.length,
    };
  }

  async cancelThreadPrAutoDispatch(
    request: CancelThreadPrAutoDispatchRequest,
  ): Promise<boolean> {
    return await this.getPrAutoDispatchCoordinator().cancelPending(request);
  }

  async sendThreadPrAutoDispatchNow(
    request: SendThreadPrAutoDispatchNowRequest,
  ): Promise<boolean> {
    return await this.getPrAutoDispatchCoordinator().sendPendingNow(request);
  }

  /**
   * Fold a poll result into the registry + cache, and publish only what
   * actually changed. Returns the changed prKeys so the scheduler can keep its
   * quiet-demotion clock.
   */
  private async applyPolledPrStatuses(
    prs: PrSummary[],
    fetchedAt: number,
    fetchedAtByKey?: ReadonlyMap<string, number>,
    transcriptOnlyPrs?: PrSummary[],
  ): Promise<string[]> {
    // The GraphQL client fetches only the PR's head commit (see the cost note
    // in github-graphql-client). Union forward so a status poll does not
    // overwrite a richer commit set retained from an older snapshot.
    const merged = prs.map((pr) => {
      const previous = this.prStatusRegistry.get(getPrStatusKey(pr))?.pr;
      const commitShas = mergeCommitShas(previous?.commitShas, pr.commitShas);
      return commitShas.length > 0 ? { ...pr, commitShas } : pr;
    });

    const { changed, cacheChanged } = this.rememberPrStatuses(merged, fetchedAt, "background-poll", { fetchedAtByKey, transcriptOnlyPrs });
    const canonical = this.canonicalizePrs(merged);
    const changedKeys = new Set(changed.map(getPrStatusKey));
    const hasCurrentObservation = (pr: PrSummary) => {
      const key = getPrStatusKey(pr);
      return this.prStatusRegistry.get(key)?.fetchedAt === (fetchedAtByKey?.get(key) ?? fetchedAt);
    };
    this.prReviewOfferCoordinator?.handleObservations(canonical.filter((pr) =>
      this.primaryPrThreadsByKey.has(getPrStatusKey(pr))
      && !changedKeys.has(getPrStatusKey(pr))
      && hasCurrentObservation(pr)));
    this.recordPrCheck(canonical, "background poll");
    await this.handlePrAutoDispatchSnapshots(canonical, fetchedAt, false, fetchedAtByKey);
    // An unchanged accepted poll refreshes CI freshness without publishing a
    // field-change event. Dependencies still need that observation for admission.
    const fresh = canonical.filter(hasCurrentObservation);
    // A newer identical read can advance a merge's timestamp while the
    // watch handler waits. Its still-current transition needs a stack read.
    const currentMergeChanges = changed.flatMap((pr) =>
      pr.lifecycleState === "merged" && !hasCurrentObservation(pr) ? this.matchingPrStatus(pr)?.pr ?? [] : []);
    this.queueStackAdvance([...fresh, ...currentMergeChanges]);
    const freshPrUrls = fresh.map((pr) => pr.url);
    // Evaluation can start a continuation turn; the poll must not wait on it.
    if (freshPrUrls.length > 0) {
      void this.threadDependencyCoordinator?.handlePrEvent(freshPrUrls)
        .catch((error) => appServerLog.warn("thread dependency evaluation failed", { error: String(error) }));
    }
    if (cacheChanged.length > 0) await this.writePrStatusesToCache(cacheChanged, fetchedAt, fetchedAtByKey);
    if (changed.length === 0) {
      return [];
    }

    // Publish on the backend that owns each PR's thread. Group so we emit one
    // batch per backend rather than one call per PR.
    const changedByBackend = new Map<AppServerBackendKind, PrSummary[]>();
    for (const pr of changed) {
      const backend = this.prPollBackendByKey.get(getPrStatusKey(pr)) ?? "codex";
      const bucket = changedByBackend.get(backend);
      if (bucket) {
        bucket.push(pr);
      } else {
        changedByBackend.set(backend, [pr]);
      }
    }
    await Promise.all(
      [...changedByBackend].map(async ([backend, prs]) =>
        await this.publishPullRequestStatusUpdates({ backend, prs, stackAlreadyObserved: true }),
      ),
    );
    return changed.map((pr) => getPrStatusKey(pr));
  }

  private async refreshPendingPrAutoDispatches(
    pending: ThreadPrAutoDispatchPending[],
  ): Promise<ReadonlySet<string>> {
    const refsByPrKey = new Map(
      pending.flatMap((item) => {
        const ref = parsePrRefFromUrl(item.prUrl);
        return ref ? [[item.prKey, ref] as const] : [];
      }),
    );
    if (refsByPrKey.size === 0) {
      return new Set();
    }
    if (!this.takePrPollingToken("recovery refresh")) {
      throw new Error("PR status refresh budget is temporarily exhausted");
    }
    const refreshed = await this.fetchForgePullRequests(
      [...refsByPrKey.values()],
    );
    if (refreshed.length > 0) {
      await this.applyPolledPrStatuses(
        refreshed,
        this.nextPrObservationTimestamp(),
      );
    }
    return new Set(refreshed.map((pr) => getPrStatusKey(pr)));
  }

  private async fetchForgePullRequests(refs: ForgePrRef[], options?: Parameters<ForgePrFetcher["fetchPullRequests"]>[1]): Promise<PrSummary[]> {
    const prs = await this.getPrFetcher().fetchPullRequests(refs, options);
    this.learnPolledPullRequestRepositories(refs, prs);
    return prs;
  }

  /**
   * A forge answers a renamed or transferred repository's old name with the
   * PR under its current name. A poll result under another repository than
   * any ref asked for is that answer: pair it with the one ref of the same
   * host and number, and learn the rename before the result is matched to
   * the threads that attached the PR under the old name.
   */
  private learnPolledPullRequestRepositories(refs: readonly ForgePrRef[], prs: readonly PrSummary[]): void {
    const requested = refs.map((ref) => ({
      host: normalizePullRequestProvider(ref.host),
      key: getPrStatusKey({ provider: ref.host, org: ref.owner, repo: ref.repo, number: ref.number }),
      url: buildPullRequestReferenceUrl({
        kind: ref.kind, provider: ref.host, org: ref.owner, repo: ref.repo, number: ref.number,
      }),
      number: ref.number,
    }));
    const requestedKeys = new Set(requested.map((ref) => ref.key));
    const answeredKeys = new Set(prs.map((pr) => getPrStatusKey(pr)));
    for (const pr of prs) {
      if (requestedKeys.has(getPrStatusKey(pr))) continue;
      const host = normalizePullRequestProvider(pr.provider);
      // A ref that got its own answer is not the one this result renames.
      const matches = requested.filter((ref) =>
        ref.number === pr.number && ref.host === host && !answeredKeys.has(ref.key)
      );
      if (matches.length === 1) this.learnPullRequestRepository(matches[0]!.url, pr);
    }
  }

  async getGlabStatus(request: GetGlabStatusRequest): Promise<GlabStatus> {
    return await this.getPrFetcher().gitlab.getAuthStatus(request.host, request.recheck);
  }

  async getGhStatus(request: GetGhStatusRequest): Promise<GhStatus> {
    const fetcher = this.getPrFetcher();
    if (request.recheck) {
      fetcher.github.invalidateGhCaches();
      this.getPrGraphqlClient().invalidateToken();
    }
    // The fetcher logs once per fresh probe (cache + in-flight dedup
    // keep StrictMode mount duplicates silent). The IPC layer just
    // returns the parsed status.
    return await fetcher.github.getAuthStatus();
  }

  async setThreadToolIncidentNotice(
    request: SetThreadToolIncidentNoticeRequest,
  ): Promise<SetThreadToolIncidentNoticeResponse> {
    /* Deliberately not federated. Dismissing or muting a cost warning is the
       viewer's own preference about what it wants to be told, the same
       reasoning that keeps composer drafts machine-local — a peer should not
       inherit this operator's decision to stop being warned. */
    const backend = request.backend ?? "codex";
    const overlay = await this.getOverlayStore().setThreadToolIncidentNotice({
      backend,
      ...(request.dismissedSeverity
        ? { dismissedSeverity: request.dismissedSeverity }
        : {}),
      ...(request.firstWarningAt !== undefined
        ? { firstWarningAt: request.firstWarningAt }
        : {}),
      ...(request.mutedSeverity ? { mutedSeverity: request.mutedSeverity } : {}),
      ...(request.reset ? { reset: request.reset } : {}),
      threadId: request.threadId,
    });
    logDebug("setThreadToolIncidentNotice", {
      backend,
      dismissedSeverity: request.dismissedSeverity,
      mutedSeverity: request.mutedSeverity,
      reset: request.reset === true,
      threadId: request.threadId,
    });
    return {
      backend,
      state: overlay.toolIncidentNotice ?? {},
      threadId: request.threadId,
    };
  }

  async listPendingThreadSpendAlerts(request: ListPendingThreadSpendAlertsRequest): Promise<ListPendingThreadSpendAlertsResponse> {
    if (!getDesktopSettingsService().resolveSpendAlertPolicy().threadSpendEnabled) {
      return { alerts: [], hasMore: false };
    }
    return this.getOverlayStore().listPendingThreadSpendAlerts(request);
  }

  async acknowledgeThreadSpendAlert(
    request: AcknowledgeThreadSpendAlertRequest,
  ): Promise<AcknowledgeThreadSpendAlertResponse> {
    const backend = request.backend ?? "codex";
    const acknowledged = await this.getOverlayStore()
      .acknowledgeThreadSpendAlert({
        alertId: request.alertId,
        backend,
        threadId: request.threadId,
      });
    logDebug("acknowledgeThreadSpendAlert", {
      acknowledged,
      alertId: request.alertId,
      backend,
      threadId: request.threadId,
    });
    return {
      acknowledged,
      backend,
      threadId: request.threadId,
    };
  }

  async continueThreadEnvironmentStartup(
    request: ContinueThreadEnvironmentStartupRequest,
  ): Promise<ContinueThreadEnvironmentStartupResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime().remoteBackend(federationTarget)
        .continueThreadEnvironmentStartup(remoteRequest);
    }
    return await getDesktopBackendRegistry().continueThreadEnvironmentStartup(request, "desktop");
  }

  async acknowledgeThreadEnvironmentFailure(
    request: AcknowledgeThreadEnvironmentFailureRequest,
  ): Promise<AcknowledgeThreadEnvironmentFailureResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime().remoteBackend(federationTarget)
        .acknowledgeThreadEnvironmentFailure(remoteRequest);
    }
    return await getDesktopBackendRegistry().acknowledgeThreadEnvironmentFailure(request);
  }

  async setThreadReaction(
    request: SetThreadReactionRequest,
  ): Promise<SetThreadReactionResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .setThreadReaction(remoteRequest);
    }
    const backend = request.backend ?? "codex";

    const overlay = await this.getOverlayStore().setThreadReaction({
      backend,
      threadId: request.threadId,
      emoji: request.emoji,
      present: request.present,
    });

    logDebug("setThreadReaction", {
      backend,
      threadId: request.threadId,
      emoji: request.emoji,
      present: request.present,
      reactionCount: overlay.reactions?.length ?? 0,
    });

    const reactions = overlay.reactions ?? [];
    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: {
        method: "thread/reactions/updated",
        params: {
          threadId: request.threadId,
          reactions,
        },
      },
    });

    return {
      backend,
      threadId: request.threadId,
      reactions,
    };
  }

  async setThreadLock(
    request: SetThreadLockRequest,
  ): Promise<SetThreadLockResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .setThreadLock(remoteRequest);
    }
    return await getDesktopBackendRegistry().setThreadLock({
      backend: request.backend ?? "codex",
      threadId: request.threadId,
      locked: request.locked,
      ...(request.note !== undefined ? { note: request.note } : {}),
    }, { source: "operator" });
  }

  async setThreadCheckoutHibernation(
    request: SetThreadCheckoutHibernationRequest,
  ): Promise<SetThreadCheckoutHibernationResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .setThreadCheckoutHibernation(remoteRequest);
    }
    return await getDesktopBackendRegistry().setThreadCheckoutHibernation({
      backend: request.backend ?? "codex",
      threadId: request.threadId,
      ...(request.restore !== undefined ? { restore: request.restore } : {}),
      ...(request.keepAwake !== undefined ? { keepAwake: request.keepAwake } : {}),
    });
  }

  async setThreadPin(
    request: SetThreadPinRequest,
  ): Promise<SetThreadPinResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      // Pin state lives in the owning instance's overlay store; writing
      // it locally would only create a phantom pin on the viewer machine
      // that the next remote snapshot overwrites.
      const { federationTarget, ...remoteRequest } = request;
      if (request.pinned !== undefined) {
        getDesktopFederationRuntime().assertRemoteNavigationQueryProtocol(federationTarget);
      }
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .setThreadPin(remoteRequest);
    }
    const backend = request.backend ?? "codex";

    const setPin = async () => await this.getOverlayStore().setThreadPin({
      backend,
      threadId: request.threadId,
      pinned: request.pinned,
      pinnedRank: request.pinnedRank,
    });
    const registry = getExistingDesktopBackendRegistry();
    const overlay = registry
      ? await registry.withThreadLifecycleMutation({ backend, threadId: request.threadId }, setPin)
      : await setPin();

    logDebug("setThreadPin", {
      backend,
      threadId: request.threadId,
      pinnedRank: overlay.pinnedRank ?? null,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: overlay.pinnedRank
        ? {
            method: "thread/pin/added",
            params: {
              threadId: request.threadId,
              pinnedRank: overlay.pinnedRank,
            },
          }
        : {
            method: "thread/pin/removed",
            params: {
              threadId: request.threadId,
            },
          },
    });

    return {
      backend,
      threadId: request.threadId,
      pinnedRank: overlay.pinnedRank,
    };
  }

  async accessAgentMemory(request: AgentMemoryRequest): Promise<AgentMemoryResult> {
    const { federationTarget, ...ownerRequest } = request;
    if (federationTarget && isRemoteFederationTarget(federationTarget)) {
      return await getDesktopFederationRuntime().remoteBackend(federationTarget).accessAgentMemory(ownerRequest);
    }
    return await getDesktopBackendRegistry().accessAgentMemorySettings(ownerRequest);
  }

  async setThreadAgent(
    request: SetThreadAgentRequest,
  ): Promise<SetThreadAgentResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime().remoteBackend(federationTarget)
        .setThreadAgent(remoteRequest);
    }
    const backend = request.backend ?? "codex";

    const overlay = await getDesktopBackendRegistry().setThreadAgent({
      backend,
      threadId: request.threadId,
      agent: request.agent,
    });

    return {
      backend,
      threadId: request.threadId,
      agent: overlay.agent,
      agentChange: summarizeThreadAgentChange(overlay.queuedAgentChange),
    };
  }

  async setThreadTokenMiser(
    request: SetThreadTokenMiserRequest,
  ): Promise<SetThreadTokenMiserResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime().remoteBackend(federationTarget)
        .setThreadTokenMiser(remoteRequest);
    }
    return await getDesktopBackendRegistry().setThreadTokenMiser(request);
  }

  async setThreadMonitorJobSuggestions(
    request: SetThreadMonitorJobSuggestionsRequest,
  ): Promise<SetThreadMonitorJobSuggestionsResponse> {
    const backend = request.backend ?? "codex";
    const overlay = await this.getOverlayStore().setThreadMonitorJobSuggestions({
      backend,
      threadId: request.threadId,
      enabled: request.enabled,
    });
    logDebug("setThreadMonitorJobSuggestions", {
      backend,
      threadId: request.threadId,
      monitorJobSuggestionsEnabled: overlay.monitorJobSuggestionsEnabled ?? null,
    });
    // Reuse the thread-agent notification path: it already tells every window
    // to re-read this thread's summary, and the override lives on the same
    // overlay row.
    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: {
        method: "thread/agent/updated",
        params: {
          threadId: request.threadId,
        },
      },
    });
    return {
      backend,
      threadId: request.threadId,
      ...(overlay.monitorJobSuggestionsEnabled !== undefined
        ? { monitorJobSuggestionsEnabled: overlay.monitorJobSuggestionsEnabled }
        : {}),
    };
  }

  async setThreadJobMonitorCreation(
    request: SetThreadJobMonitorCreationRequest,
  ): Promise<SetThreadJobMonitorCreationResponse> {
    const { federationTarget, ...ownerRequest } = request;
    if (federationTarget && isRemoteFederationTarget(federationTarget)) {
      if (ownerRequest.backend !== undefined && ownerRequest.backend !== "codex") {
        throw new Error("Federated Job Monitor controls require a Codex thread.");
      }
      const runtime = getDesktopFederationRuntime();
      if (!runtime.remoteTargetSupportsCapability(federationTarget, "thread_job_monitor_control")
        || !runtime.remoteTargetSupportsCapability(federationTarget, "turn_control")) {
        throw new Error("The owning instance does not offer Job Monitor controls over Federation.");
      }
      return await runtime.remoteBackend(federationTarget).setThreadJobMonitorCreation(ownerRequest);
    }
    return await getDesktopBackendRegistry().setThreadJobMonitorCreation(ownerRequest);
  }

  async reorderThreadPins(
    request: ReorderThreadPinsRequest,
  ): Promise<ReorderThreadPinsResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...remoteRequest } = request;
      if (request.move) {
        getDesktopFederationRuntime().assertRemoteNavigationQueryProtocol(federationTarget);
      }
      const ownerPrefix = `remote:${federationTarget.instanceId}:`;
      const ownerKey = (key: string): string => key.startsWith(ownerPrefix) ? key.slice(ownerPrefix.length) : key;
      const result = await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .reorderThreadPins({
          ...remoteRequest,
          threadKeys: remoteRequest.threadKeys?.map(ownerKey),
          move: remoteRequest.move ? (remoteRequest.move.direction
            ? { key: ownerKey(remoteRequest.move.key), direction: remoteRequest.move.direction }
            : remoteRequest.move.keepAtTop !== undefined
              ? { key: ownerKey(remoteRequest.move.key), keepAtTop: remoteRequest.move.keepAtTop }
              : { key: ownerKey(remoteRequest.move.key), anchorKey: ownerKey(remoteRequest.move.anchorKey), placement: remoteRequest.move.placement })
            : undefined,
        });
      return { pinnedRanks: Object.fromEntries(Object.entries(result.pinnedRanks).map(([key, rank]) => [
        key.startsWith("remote:") ? key : `${ownerPrefix}${key}`, rank,
      ])) };
    }
    // The pinned section interleaves local pins and viewer-owned remote
    // pins. The store assigns ranks from the FULL requested order in one
    // transaction, routing each key to its own storage — local thread
    // overlay vs the remote pin row — so remote ranks never reach the owner
    // and a mixed reorder is atomic.
    const overlayStore = this.getOverlayStore();
    const remotePins =
      !request.move && typeof overlayStore.listRemoteThreadPins === "function"
        ? await overlayStore.listRemoteThreadPins()
        : [];
    const remoteRefsByKey = Object.fromEntries(
      remotePins.map((pin) => [
        federatedThreadIdentityKey(pin.ref),
        pin.ref,
      ]),
    );
    const pinnedRanks = await overlayStore.reorderThreadPins({
      threadKeys: request.threadKeys,
      ...(request.move ? { move: request.move } : {}),
      remoteRefsByKey,
    });

    logDebug("reorderThreadPins", {
      pinCount: request.threadKeys?.length ?? 1,
      remotePinCount: Object.keys(remoteRefsByKey).length,
    });

    // Pin order is global across backends, so this is a global notification.
    // `backend` is required by publishLocalEvent but irrelevant here — use a
    // fixed value (matches the directory/pin/reordered handler).
    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification: {
        method: "thread/pin/reordered",
        params: {
          pinnedRanks,
        },
      },
    });

    return { pinnedRanks };
  }

  async hasRemoteThreadPin(request: HasRemoteThreadPinRequest): Promise<boolean> {
    validateRemoteThreadPinRef(request.ref);
    return await this.getOverlayStore().hasRemoteThreadPin({ ref: request.ref });
  }

  async addRemoteThreadPin(
    request: AddRemoteThreadPinRequest,
  ): Promise<AddRemoteThreadPinResponse> {
    const instanceId = validateRemoteThreadPinRef(request.ref);
    const instanceLabel =
      request.instanceLabel
      ?? request.summary?.federation?.instanceLabel
      ?? instanceId;
    const pin = await this.getOverlayStore().addRemoteThreadPin({
      ref: request.ref,
      summary: request.summary,
      instanceLabel,
      pinnedVia: "explicit",
    });
    const companionParentRef = await this.pinCompanionParent(
      request,
      instanceId,
      instanceLabel,
    );
    const rankedRef = await this.rankRemotePinForVisibility(request, companionParentRef);

    logDebug("addRemoteThreadPin", {
      backend: request.ref.backend,
      instanceId,
      threadId: request.ref.threadId,
    });

    // Publish the mount after both rows and any visibility rank are written.
    // The ranked companion moves sections and the previously orphaned child
    // can leave the roots altogether. Retire either unpinned anchor.
    const changedRef = rankedRef ?? request.ref;
    const changedInstanceId = isRemoteFederationTarget(changedRef.target) ? changedRef.target.instanceId : instanceId;
    const publication = {
      publicationId: randomUUID(),
      backend: changedRef.backend,
      instanceId: changedInstanceId,
      threadId: changedRef.threadId,
      pinned: true as const,
      ...(rankedRef && companionParentRef ? { anchorChanges: [
        { backend: rankedRef.backend, threadId: rankedRef.threadId, ownerInstanceId: changedInstanceId },
        { backend: request.ref.backend, threadId: request.ref.threadId, ownerInstanceId: instanceId },
      ] } : {}),
    };
    await getDesktopBackendRegistry().publishLocalEvent({
      backend: publication.backend,
      notification: {
        method: "navigation/remoteThreadPins/changed",
        params: publication,
      },
    });

    return { pin, publication };
  }

  /**
   * Deliberate opinion: pinning a remote sub-thread also pins its parent —
   * an orphan child renders as a bare top-level row, losing the nesting and
   * the parent's PR context that make it legible. One hop only (sub-threads
   * are one level deep), best-effort (the parent must exist in its owning
   * instance's current snapshot — an archived parent must not resurrect as a
   * phantom row), and never downgrades an existing explicit pin. Removal stays
   * per-row: companion pins are ordinary independent pins, tagged
   * `pinnedVia: "companion"` for future group-removal UX.
   */
  private async pinCompanionParent(
    request: AddRemoteThreadPinRequest,
    instanceId: string,
    instanceLabel: string,
  ): Promise<FederatedThreadRef | undefined> {
    const parentThreadId = request.summary?.parentThreadId;
    const parentBackend =
      request.summary?.parentThreadBackend ?? request.ref.backend;
    const parentInstanceId =
      request.summary?.parentThreadInstanceId ?? instanceId;
    if (
      !parentThreadId
      || (
        parentThreadId === request.ref.threadId
        && parentBackend === request.ref.backend
      )
    ) {
      return undefined;
    }
    try {
      if (
        parentInstanceId
        === (await getDesktopFederationRuntime().health()).instanceId
      ) {
        return undefined;
      }
      const parentRef = buildFederatedThreadRef({
        backend: parentBackend,
        instanceId: parentInstanceId,
        threadId: parentThreadId,
      });
      const overlayStore = this.getOverlayStore();
      if (await overlayStore.hasRemoteThreadPin({ ref: parentRef })) {
        return parentRef;
      }
      const consumer = `pin-parent:${randomUUID()}`;
      let page: NavigationQueryPage;
      try {
        page = await this.getNavigationQueryPage({
          protocol: 2,
          consumer: "exact-link",
          inventory: "owner",
          federationTarget: { scope: "remote", instanceId: parentInstanceId },
          query: {
            kind: "exact",
            identities: [{ backend: parentBackend, threadId: parentThreadId, ownerInstanceId: parentInstanceId }],
            includeAncestry: false,
          },
          pageSize: 1,
        }, consumer);
      } finally {
        navigationQueryPool.release(consumer);
      }
      if (page.protocol !== 2 || page.coverage.state !== "complete" || !page.complete || page.nextCursor || page.unchanged) {
        return undefined;
      }
      const parentSummary = page.entries.find(({ row }) => row.ref.backend === parentBackend
        && row.ref.threadId === parentThreadId && row.ref.ownerInstanceId === parentInstanceId
        && row.source === parentBackend && row.id === parentThreadId)?.row;
      if (!parentSummary || parentSummary.archivedAt !== undefined) {
        return undefined;
      }
      await overlayStore.addRemoteThreadPin({
        ref: parentRef,
        summary: parentSummary,
        instanceLabel:
          parentSummary.federation?.instanceLabel ?? instanceLabel,
        pinnedVia: "companion",
      });
      logDebug("addRemoteThreadPin:companion-parent", {
        backend: parentBackend,
        instanceId: parentInstanceId,
        threadId: parentThreadId,
        childThreadId: request.ref.threadId,
      });
      return parentRef;
    } catch (error) {
      // Companion pinning is a convenience — the explicit pin must succeed
      // regardless.
      appServerLog.warn("Companion parent pin failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Mirror of the created-thread visibility auto-pin (backend-registry):
   * when the freshly pinned remote thread's home directory group has its
   * Directory Threads section collapsed and the pinned section is in use,
   * the row would be invisible — give its top-level row a VIEWER-owned rank
   * so it surfaces at the top of Pins. The top-level row is the companion
   * parent when one is pinned; otherwise the thread itself, since a child
   * whose parent is absent from the list renders top-level. Reads
   * overlay-store scans and
   * the cached directory summaries from the last snapshot build — never a
   * fresh snapshot, so pin latency stays independent of backends and peers.
   * Best-effort; the pin itself must succeed regardless.
   */
  private async rankRemotePinForVisibility(
    request: AddRemoteThreadPinRequest,
    companionParentRef: FederatedThreadRef | undefined,
  ): Promise<FederatedThreadRef | undefined> {
    try {
      const targetRef = companionParentRef ?? request.ref;
      const overlayStore = this.getOverlayStore();
      const pins =
        typeof overlayStore.listRemoteThreadPins === "function"
          ? await overlayStore.listRemoteThreadPins()
          : [];
      const targetPin = pins.find(
        (pin) =>
          pin.ref.backend === targetRef.backend
          && pin.ref.threadId === targetRef.threadId
          && isRemoteFederationTarget(pin.ref.target)
          && isRemoteFederationTarget(targetRef.target)
          && pin.ref.target.instanceId === targetRef.target.instanceId,
      );
      // An already-ranked row needs nothing.
      if (!targetPin || targetPin.localPinnedRank) {
        return;
      }
      const targetSummary = targetPin.summary ?? request.summary;
      // Cached from the last snapshot build — always warm in a running
      // window; a cold cache just skips this best-effort step.
      const directories = [...this.lastDirectoriesByKey.values()];
      const homeIndex = findRemoteHomeDirectoryIndex(
        directories,
        targetSummary ?? { linkedDirectories: [] },
      );
      const home = homeIndex === undefined ? undefined : directories[homeIndex];
      if (!home?.directoryThreadsCollapsed) {
        return;
      }
      const localRanks = await overlayStore.listPinnedThreadOverlayRanks();
      // Mirror the created-thread rule: only when the pinned section is in
      // use would the row otherwise be invisible.
      const hasPinnedTopLevelThread =
        localRanks.some((entry) => !entry.parentThreadId)
        || pins.some(
          (pin) => pin.localPinnedRank && !pin.summary?.parentThreadId,
        );
      if (!hasPinnedTopLevelThread) {
        return;
      }
      const pinnedRank = buildPrependPinRank([
        ...localRanks.map((entry) => entry.pinnedRank),
        ...pins.map((pin) => pin.localPinnedRank),
      ]);
      await overlayStore.setRemoteThreadLocalPin({
        ref: targetRef,
        pinnedRank,
      });
      logDebug("addRemoteThreadPin:visibility-rank", {
        backend: targetRef.backend,
        threadId: targetRef.threadId,
        directoryKey: home.key,
      });
      return targetRef;
    } catch (error) {
      appServerLog.warn("Remote pin visibility rank failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async removeRemoteThreadPin(
    request: RemoveRemoteThreadPinRequest,
  ): Promise<RemoveRemoteThreadPinResponse> {
    const instanceId = validateRemoteThreadPinRef(request.ref);
    // Local DELETE only — removal must keep working while the owning
    // instance is unreachable, and the owner's thread is untouched.
    const removed = await this.getOverlayStore().removeRemoteThreadPin({
      ref: request.ref,
    });

    logDebug("removeRemoteThreadPin", {
      backend: request.ref.backend,
      instanceId,
      threadId: request.ref.threadId,
      removed,
    });

    if (removed) {
      await getDesktopBackendRegistry().publishLocalEvent({
        backend: request.ref.backend,
        notification: {
          method: "navigation/remoteThreadPins/changed",
          params: {
            instanceId,
            threadId: request.ref.threadId,
            pinned: false,
          },
        },
      });
    }

    return { removed };
  }

  /**
   * VIEWER-owned pin rank for a remote thread in the main window's list.
   * Never routed to the owner: pin or unpin here and only the viewer knows.
   * (Remote-viewer windows keep the existing setThreadPin owner routing —
   * operating the owner's pinned section is intended there.)
   */
  async setRemoteThreadLocalPin(
    request: SetRemoteThreadLocalPinRequest,
  ): Promise<SetRemoteThreadLocalPinResponse> {
    const instanceId = validateRemoteThreadPinRef(request.ref);
    const result = await this.getOverlayStore().setRemoteThreadLocalPin({
      ref: request.ref,
      pinned: request.pinned,
      pinnedRank: request.pinnedRank,
    });
    await getDesktopBackendRegistry().publishLocalEvent({
      backend: request.ref.backend,
      notification: {
        method: "navigation/remoteThreadPins/changed",
        params: {
          instanceId,
          threadId: request.ref.threadId,
          pinned: Boolean(result.pinnedRank),
          membershipChanged: false,
        },
      },
    });
    return { ref: request.ref, pinnedRank: result.pinnedRank };
  }

  async jumpSearchRemoteThreads(
    request: FederationJumpSearchRequest,
    onProgress?: (progress: FederationJumpSearchProgress) => void,
  ): Promise<FederationJumpSearchResponse> {
    return await searchNavigationOwners({ request, onProgress,
      owners: getDesktopFederationRuntime().connectedPeerTargets().filter((peer) => peer.capabilities.includes("thread_navigation")),
      readPage: async (query) => {
        const consumer = `jump-search:${randomUUID()}`;
        try { return await this.getNavigationQueryPage(query, consumer); }
        finally { navigationQueryPool.release(consumer); }
      },
    });
  }

  async setThreadParent(
    request: SetThreadParentRequest,
  ): Promise<SetThreadParentResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...ownerRequest } = request;
      const federationRuntime = getDesktopFederationRuntime();
      if (request.expectedParent !== undefined) {
        federationRuntime.assertRemoteNavigationQueryProtocol(federationTarget);
      }
      const response = await federationRuntime
        .remoteBackend(federationTarget)
        .setThreadParent(ownerRequest);
      try {
        const pins = await this.getOverlayStore().listRemoteThreadPins();
        const pin = pins.find(
          (candidate) =>
            candidate.ref.backend === response.backend
            && candidate.ref.threadId === response.threadId
            && isRemoteFederationTarget(candidate.ref.target)
            && candidate.ref.target.instanceId === federationTarget.instanceId,
        );
        if (pin?.summary) {
          const summary = { ...pin.summary };
          if (response.parentThreadId) {
            summary.parentThreadId = response.parentThreadId;
            summary.parentThreadBackend = response.parentThreadBackend;
            summary.parentThreadInstanceId = response.parentThreadInstanceId;
          } else {
            delete summary.parentThreadId;
            delete summary.parentThreadBackend;
            delete summary.parentThreadInstanceId;
          }
          await this.getOverlayStore().updateRemoteThreadPinSnapshots([{
            ref: pin.ref,
            summary,
            instanceLabel: pin.instanceLabel,
          }]);
        }
        // Nesting unpins, as a local thread's link does. This viewer's own
        // rank would otherwise bring the row back to its pins on refresh.
        if (pin?.localPinnedRank && response.parentThreadId) {
          await this.getOverlayStore().setRemoteThreadLocalPin({ ref: pin.ref, pinned: false });
        }
      } catch (error) {
        // The relationship mutation already committed on the owner. Keep that
        // success authoritative even if this viewer's cached pin cannot patch.
        appServerLog.warn("Remote parent change cache update failed.", {
          error: error instanceof Error ? error.message : String(error),
          instanceId: federationTarget.instanceId,
          threadId: response.threadId,
        });
      }
      federationRuntime.remoteThreadSummaries().invalidate(
        federationTarget.instanceId,
      );
      return response;
    }
    const backend = request.backend ?? "codex";
    const overlay = await this.getOverlayStore().setThreadParent({
      backend,
      threadId: request.threadId,
      parentThreadId: request.parentThreadId,
      parentThreadBackend: request.parentThreadBackend,
      parentThreadInstanceId: request.parentThreadInstanceId,
      expectedParent: request.expectedParent,
    });

    logDebug("setThreadParent", {
      backend,
      threadId: request.threadId,
      parentThreadId: overlay.parentThreadId ?? null,
      parentThreadBackend: overlay.parentThreadBackend ?? null,
      parentThreadInstanceId: overlay.parentThreadInstanceId ?? null,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: overlay.parentThreadId
        ? {
            method: "thread/parent/set",
            params: {
              threadId: request.threadId,
              parentThreadId: overlay.parentThreadId,
              parentThreadBackend: overlay.parentThreadBackend,
              parentThreadInstanceId: overlay.parentThreadInstanceId,
            },
          }
        : {
            method: "thread/parent/cleared",
            params: {
              threadId: request.threadId,
            },
          },
    });

    return {
      backend,
      threadId: request.threadId,
      parentThreadId: overlay.parentThreadId,
      parentThreadBackend: overlay.parentThreadBackend,
      parentThreadInstanceId: overlay.parentThreadInstanceId,
    };
  }

  async updateSubthreadOrder(
    request: UpdateSubthreadOrderRequest,
  ): Promise<UpdateSubthreadOrderResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...ownerRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .updateSubthreadOrder(ownerRequest);
    }
    const response = await updateLocalSubthreadOrder(request, {
      peers: getDesktopFederationRuntime().peerChildSource(),
    });
    logDebug("updateSubthreadOrder", {
      backend: response.backend,
      parentThreadId: request.parentThreadId,
      // A relative move answers no order; name what moved instead.
      ...(response.threadIds
        ? { childCount: response.threadIds.length }
        : { movedThreadId: request.move?.threadId ?? request.insertAfter?.threadId }),
    });
    return response;
  }

  async setSubthreadsCollapsed(
    request: SetSubthreadsCollapsedRequest,
  ): Promise<SetSubthreadsCollapsedResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...ownerRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .setSubthreadsCollapsed(ownerRequest);
    }
    const backend = request.backend ?? "codex";
    const overlay = await this.getOverlayStore().setSubthreadsCollapsed({
      backend,
      parentThreadId: request.parentThreadId,
      collapsed: request.collapsed,
    });

    logDebug("setSubthreadsCollapsed", {
      backend,
      parentThreadId: request.parentThreadId,
      collapsed: overlay.subthreadsCollapsed === true,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: {
        method: "thread/subthreadsCollapsed/updated",
        params: {
          parentThreadId: request.parentThreadId,
          collapsed: overlay.subthreadsCollapsed === true,
        },
      },
    });

    return {
      backend,
      parentThreadId: request.parentThreadId,
      collapsed: overlay.subthreadsCollapsed === true,
    };
  }

  async setDirectoryPin(
    request: SetDirectoryPinRequest,
  ): Promise<SetDirectoryPinResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime().remoteBackend(federationTarget).setDirectoryPin(remoteRequest);
    }
    return await setLocalDirectoryPin(request);
  }

  async reorderDirectoryPins(
    request: ReorderDirectoryPinsRequest,
  ): Promise<ReorderDirectoryPinsResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime().remoteBackend(federationTarget).reorderDirectoryPins(remoteRequest);
    }
    return await reorderLocalDirectoryPins(request);
  }

  async setDirectoryThreadsCollapsed(
    request: SetDirectoryThreadsCollapsedRequest,
  ): Promise<SetDirectoryThreadsCollapsedResponse> {
    rejectNonUserDirectoryKey(request.directoryKey);

    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const overlay = await this.getOverlayStore()
        .setRemoteDirectoryThreadsCollapsed({
          instanceId: request.federationTarget.instanceId,
          directoryKey: request.directoryKey,
          collapsed: request.collapsed,
        });
      const collapsed = overlay.directoryThreadsCollapsed === true;
      logDebug("setDirectoryThreadsCollapsed:remote-viewer", {
        instanceId: request.federationTarget.instanceId,
        directoryKey: request.directoryKey,
        collapsed,
      });
      return {
        directoryKey: request.directoryKey,
        collapsed,
      };
    }

    const overlay = await this.getOverlayStore().setDirectoryThreadsCollapsed({
      directoryKey: request.directoryKey,
      collapsed: request.collapsed,
    });
    const collapsed = overlay.directoryThreadsCollapsed === true;

    logDebug("setDirectoryThreadsCollapsed", {
      directoryKey: request.directoryKey,
      collapsed,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification: {
        method: "directory/threadsCollapsed/updated",
        params: {
          directoryKey: request.directoryKey,
          collapsed,
        },
      },
    });

    return {
      directoryKey: request.directoryKey,
      collapsed,
    };
  }

  /**
   * Add one hands-off rule to the thread's project, as the operator's click
   * on an agent's proposal card. A rule already there is a no-op; the list's
   * cap is a refusal, not a silent drop.
   */
  async addThreadProjectHandsOffRule(request: {
    backend: AppServerBackendKind;
    threadId: string;
    repository: string;
    label?: string;
  }): Promise<{ summary: string }> {
    const [rule] = normalizeHandsOffRules([{ repository: request.repository, label: request.label }]);
    if (!rule) throw new Error("That hands-off rule needs a repository as owner/name.");
    const index = getProjectForgeAutomationIndex();
    const directoryKey = this.threadForgeDirectoryKey(request);
    if (!directoryKey) throw new Error("This thread is in no Directories project, so it has no Forge Automation to add the rule to.");
    const label = index.label(directoryKey);
    const current = resolveProjectForgeAutomation(index.get(directoryKey));
    const existing = current.handsOff ?? [];
    const described = rule.label ? `PRs into ${rule.repository} labeled ${rule.label}` : `PRs into ${rule.repository}`;
    const key = (entry: { repository: string; label?: string }) => `${entry.repository}\n${entry.label ?? ""}`.toLowerCase();
    if (existing.some((entry) => key(entry) === key(rule))) {
      return { summary: `${label} already leaves ${described} hands-off` };
    }
    if (existing.length >= MAX_HANDS_OFF_RULES) {
      throw new Error(`${label} already has ${MAX_HANDS_OFF_RULES} hands-off rules. Remove one in Forge Automation first.`);
    }
    await this.setProjectForgeAutomation({ directoryKey, automation: { ...current, handsOff: [...existing, rule] } });
    return { summary: `${label} now leaves ${described} hands-off` };
  }

  /**
   * Save a local Directories project's Forge Automation in one commit, then
   * apply it: repairs the project no longer allows are cancelled, and a
   * resume re-checks its PRs and PR prerequisites at once. Polling follows
   * on its next tick, since every tick reads the index.
   */
  async setProjectForgeAutomation(
    request: SetProjectForgeAutomationRequest,
  ): Promise<SetProjectForgeAutomationResponse> {
    const directoryKey = readProjectForgeDirectoryKey(request);
    if (!request.automation || typeof request.automation !== "object") {
      throw new Error("Forge Automation settings are required.");
    }
    const owner = remoteProjectForgeOwner(request);
    if (owner) {
      return await owner.setProjectForgeAutomation({
        directoryKey,
        automation: resolveProjectForgeAutomation(request.automation),
      });
    }
    const index = getProjectForgeAutomationIndex();
    const previous = index.get(directoryKey);
    const overlay = await this.getOverlayStore().setDirectoryForgeAutomation({
      directoryKey,
      automation: resolveProjectForgeAutomation(request.automation),
      now: Date.now(),
    });
    const automation = resolveProjectForgeAutomation(overlay.forgeAutomation);
    const stored = isDefaultProjectForgeAutomation(automation) ? undefined : automation;
    index.set(directoryKey, stored ?? null);

    logDebug("setProjectForgeAutomation", {
      directoryKey,
      paused: automation.paused,
      autoFixMergeConflicts: automation.autoFixMergeConflicts,
      autoFixCiFailures: automation.autoFixCiFailures,
      prWatches: automation.prWatches,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification: {
        method: "directory/forgeAutomation/updated",
        params: { directoryKey, automation: stored ?? null },
      },
    });
    await this.applyProjectForgeAutomationChange(directoryKey, previous, stored)
      .catch((error: unknown) => {
        appServerLog.warn("failed to apply project Forge Automation", {
          directoryKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return { directoryKey, automation };
  }

  /** Wake-ups the project's paused threads hold, for the resume dialog. */
  async listProjectHeldWakeups(
    request: ListProjectHeldWakeupsRequest,
  ): Promise<ListProjectHeldWakeupsResponse> {
    const directoryKey = readProjectForgeDirectoryKey(request);
    const owner = remoteProjectForgeOwner(request);
    if (owner) return await owner.listProjectHeldWakeups({ directoryKey });
    return {
      directoryKey,
      wakeups: getDesktopBackendRegistry().listProjectHeldWakeups(directoryKey),
    };
  }

  /** Send or discard held wake-ups; an operator action, allowed while paused. */
  async resolveProjectHeldWakeups(
    request: ResolveProjectHeldWakeupsRequest,
  ): Promise<ResolveProjectHeldWakeupsResponse> {
    const directoryKey = readProjectForgeDirectoryKey(request);
    assertProjectHeldWakeupResolutions(request.resolutions);
    const owner = remoteProjectForgeOwner(request);
    if (owner) {
      return await owner.resolveProjectHeldWakeups({
        directoryKey,
        resolutions: request.resolutions,
      });
    }
    return await getDesktopBackendRegistry().resolveProjectHeldWakeups({
      directoryKey,
      resolutions: request.resolutions,
    });
  }

  /** Threads filed under a project: the last scan's, plus any newer ones. */
  private projectThreadKeys(directoryKey: string): string[] {
    const index = getProjectForgeAutomationIndex();
    const threadKeys = new Set(index.threadKeysForDirectory(directoryKey));
    for (const threadKey of this.attachedPrsByThreadKey.keys()) {
      if (threadKeys.has(threadKey)) continue;
      const identity = parseThreadIdentityKey(threadKey);
      if (identity && index.directoryKeyForThread(
        identity,
        () => getDesktopBackendRegistry().getCachedThreadSummary(identity),
      ) === directoryKey) {
        threadKeys.add(threadKey);
      }
    }
    return [...threadKeys];
  }

  private async applyProjectForgeAutomationChange(
    directoryKey: string,
    previous: ProjectForgeAutomation | undefined,
    next: ProjectForgeAutomation | undefined,
  ): Promise<void> {
    const threadKeys = this.projectThreadKeys(directoryKey);
    if (threadKeys.length === 0) return;
    const narrowsAutoFix = Boolean(next)
      && (!projectAllowsAutoFixKind(next, "merge-conflict") || !projectAllowsAutoFixKind(next, "ci-failure"));
    if (narrowsAutoFix && getAppStateMode()) {
      const coordinator = this.getPrAutoDispatchCoordinator();
      for (const threadKey of threadKeys) {
        const identity = parseThreadIdentityKey(threadKey);
        if (identity) await coordinator.cancelPendingDisallowedByProject(identity);
      }
    }
    const handsOffChanged = JSON.stringify(previous?.handsOff ?? [])
      !== JSON.stringify(next?.handsOff ?? []);
    if (handsOffChanged && getAppStateMode()) {
      // Poll now, so a new label rule's labels arrive before a pending
      // repair dispatches; that repair is cancelled at dispatch.
      this.prPollingScheduler?.noteThreadInteraction(threadKeys);
      void this.prPollingScheduler?.tick().catch((error: unknown) => {
        appServerLog.debug("hands-off PR poll failed", {
          directoryKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (projectNeverMerges(previous) !== projectNeverMerges(next)
      || projectMergeBranches(previous).join("\n") !== projectMergeBranches(next).join("\n")
      || projectAllowsPrOffers(previous) !== projectAllowsPrOffers(next)
      || handsOffChanged) {
      // Withdraw an open offer now (a merge offer in a never-merge project,
      // any offer the project no longer allows), or offer it again: a
      // reviewed, green PR may see no further transition to re-evaluate it.
      this.prReviewOfferCoordinator?.reevaluate(threadKeys.flatMap((threadKey) => {
        const attachment = this.attachedPrsByThreadKey.get(threadKey);
        return (attachment?.prs ?? [])
          .filter((pr) => this.matchesPrimaryRepository(pr, attachment?.primaryRepoKey))
          .map(getPrStatusKey);
      }));
    }
    const resumedPolling = !projectAllowsForgePolling(previous) && projectAllowsForgePolling(next);
    if (resumedPolling) {
      // Thaw and poll the project's PRs now rather than on their next slot.
      // Nothing missed while paused is replayed: only current status counts.
      this.prPollingScheduler?.noteThreadInteraction(threadKeys);
      void this.prPollingScheduler?.tick().catch((error: unknown) => {
        appServerLog.debug("resume PR poll failed", {
          directoryKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    // CI run waits are checked only while their project allows PR watches.
    if (projectAllowsPrWatches(previous) !== projectAllowsPrWatches(next)) {
      this.threadDependencyCiRunPoller?.sync();
      this.threadDependencyMergeBuildPoller?.sync();
      this.ciApprovalPoller?.sync();
    }
    if (!projectAllowsPrWatches(previous) && projectAllowsPrWatches(next) && getAppStateMode()) {
      await this.getThreadDependencyCoordinator().handlePrEvent();
      // A merge or close seen while watches were held left its watch
      // pending, and the poller no longer fetches a terminal PR. Re-offer it.
      for (const threadKey of threadKeys) {
        const identity = parseThreadIdentityKey(threadKey);
        if (identity) await this.retryPendingPrTerminalWatches(identity);
      }
    }
  }

  async ensureDirectoryLaunchpad(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const {
        federationTarget,
        gitStatus: snapshotGitStatus,
        ...ownerRequest
      } = request;
      const federationRuntime = getDesktopFederationRuntime();
      const ownerResponse =
        federationRuntime.remoteTargetSupportsCapability(
          federationTarget,
          "launchpad_metadata",
        )
          ? await federationRuntime
              .remoteBackend(federationTarget)
              .ensureDirectoryLaunchpad(ownerRequest)
          : undefined;
      const ownerGitStatus =
        ownerResponse?.gitStatus
        ?? snapshotGitStatus
        ?? (request.currentBranch
          ? { currentBranch: request.currentBranch }
          : undefined);
      const registry = getDesktopBackendRegistry();
      const localResponse = await registry.ensureDirectoryLaunchpad(
        {
          ...ownerRequest,
          directoryKind:
            ownerResponse?.launchpad.directoryKind ?? request.directoryKind,
          directoryLabel:
            ownerResponse?.launchpad.directoryLabel ?? request.directoryLabel,
          directoryPath:
            ownerResponse?.launchpad.directoryPath ?? request.directoryPath,
          currentBranch: undefined,
        },
        {
          skipFilesystemInspection: true,
          skipMcpConnectionDefaults: true,
          owner: federationTarget,
        },
      );
      const resolvedLocalResponse = ownerResponse
        ? await resolveRemoteLaunchpadSettings({
            localResponse,
            ownerResponse,
            preferredBackend: request.preferredBackend,
            listOwnerBackends: async () =>
              (await federationRuntime
                .remoteBackend(federationTarget)
                .listBackends({ includeUnavailable: true })).backends,
            updateDraftSettings: async (from, patch, ownerProviderSettings) =>
              (await registry.updateDirectoryLaunchpad(
                { directoryKey: request.directoryKey, patch },
                {
                  skipFilesystemInspection: true,
                  ...(ownerProviderSettings ? { ownerProviderSettings } : {}),
                  // The owner was asked over the wire; an operator pick made
                  // meanwhile, here or in another window, is theirs.
                  onlyIf: (current) =>
                    current.backend === from
                    && current.settingsTouchedAt === undefined,
                  owner: federationTarget,
                },
              )).launchpad,
          })
        : localResponse;
      const branchName = reconcileRemoteLaunchpadBranch(
        resolvedLocalResponse.launchpad.branchName,
        ownerGitStatus,
      );
      return {
        ...resolvedLocalResponse,
        launchpad: {
          ...resolvedLocalResponse.launchpad,
          federationTarget,
          directoryKind:
            ownerResponse?.launchpad.directoryKind ?? request.directoryKind,
          directoryLabel:
            ownerResponse?.launchpad.directoryLabel ?? request.directoryLabel,
          directoryPath:
            ownerResponse?.launchpad.directoryPath ?? request.directoryPath,
          codexEnvironmentOptions:
            ownerResponse?.launchpad.codexEnvironmentOptions,
          branchName,
        },
        gitStatus: ownerGitStatus,
        // The owner resolved its defaults from `preferredBackend` against its
        // own providers; the local draft above used this instance's.
        ...preferredBackendFallback(
          request.preferredBackend,
          ownerResponse?.defaults.backend,
        ),
      };
    }

    const refreshed = await this.directoryGitStatus.refreshLaunchpadDirectoryGitStatus(request);
    const response = await getDesktopBackendRegistry().ensureDirectoryLaunchpad(
      refreshed.request,
    );
    return {
      ...response,
      ...(refreshed.gitStatus !== undefined
        ? { gitStatus: refreshed.gitStatus }
        : {}),
      ...preferredBackendFallback(request.preferredBackend, response.defaults.backend),
    };
  }

  async updateDirectoryLaunchpad(
    request: UpdateDirectoryLaunchpadRequest,
  ): Promise<UpdateDirectoryLaunchpadResponse> {
    // A peer's draft is stored apart from this machine's draft for its key.
    return await getDesktopBackendRegistry().updateDirectoryLaunchpad(request, {
      owner: request.federationTarget,
    });
  }

  async resetDirectoryLaunchpad(
    request: ResetDirectoryLaunchpadRequest,
  ): Promise<ResetDirectoryLaunchpadResponse> {
    return await getDesktopBackendRegistry().resetDirectoryLaunchpad(request, {
      owner: request.federationTarget,
    });
  }

  async pickDirectoryFromDisk(
    parentWindow?: unknown,
  ): Promise<PickDirectoryFromDiskResponse> {
    const e2ePickPath = process.env.PWRAGENT_REPLAY_FIXTURE_PATH
      ? process.env.PWRAGENT_E2E_PICK_DIRECTORY_PATH?.trim()
      : undefined;
    if (e2ePickPath) {
      return { canceled: false, path: e2ePickPath };
    }

    // Anchor the dialog to whichever window dispatched the IPC so it
    // appears as a sheet on macOS (the renderer's expectation) instead
    // of floating free. `dialog.showOpenDialog` accepts an optional
    // `BrowserWindow` first arg for exactly this; if the caller didn't
    // pass one we fall back to the focused window.
    // Open where the user last browsed (the parent of their last pick), else the
    // home folder — much friendlier than the OS default, which is Documents on a
    // fresh Windows profile and looks like you can't escape it.
    const defaultPath = this.lastPickedDirectoryParent ?? os.homedir();
    const result = await getOwnerHostServices().ui.pickFiles({
      title: "Add directory",
      buttonLabel: "Add directory",
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
    }, parentWindow);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    this.lastPickedDirectoryParent = path.dirname(result.filePaths[0]);
    return { canceled: false, path: result.filePaths[0] };
  }

  async pickFileFromDisk(
    parentWindow?: unknown,
  ): Promise<PickFileFromDiskResponse> {
    const e2ePickPaths = process.env.PWRAGENT_REPLAY_FIXTURE_PATH
      ? process.env.PWRAGENT_E2E_PICK_FILE_PATHS?.trim()
      : undefined;
    if (e2ePickPaths) {
      return {
        canceled: false,
        paths: e2ePickPaths.split(":").filter(Boolean),
      };
    }

    const defaultPath = this.lastPickedDirectoryParent ?? os.homedir();
    const options = {
      title: "Add file",
      buttonLabel: "Add file",
      defaultPath,
      properties: ["openFile", "multiSelections"] as Array<
        "openFile" | "multiSelections"
      >,
    };
    const result = await getOwnerHostServices().ui.pickFiles(options, parentWindow);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    this.lastPickedDirectoryParent = path.dirname(result.filePaths[0]);
    return { canceled: false, paths: result.filePaths };
  }

  /**
   * Combined file-or-directory reference picker. Only macOS can combine
   * `openFile` + `openDirectory` in one dialog (Electron limitation on
   * Windows/Linux — which is why the composer's reference picker keeps
   * separate "Add directory…" / "Add file…" actions off-macOS). Each
   * pick is classified via `fs.stat`; unreadable paths are skipped.
   */
  async pickReferenceFromDisk(
    parentWindow?: unknown,
  ): Promise<PickReferenceFromDiskResponse> {
    const e2ePickPaths = process.env.PWRAGENT_REPLAY_FIXTURE_PATH
      ? process.env.PWRAGENT_E2E_PICK_REFERENCE_PATHS?.trim()
      : undefined;
    if (e2ePickPaths) {
      return {
        canceled: false,
        entries: classifyReferencePaths(e2ePickPaths.split(":").filter(Boolean)),
      };
    }

    const defaultPath = this.lastPickedDirectoryParent ?? os.homedir();
    const options = {
      title: "Add reference",
      buttonLabel: "Add reference",
      defaultPath,
      properties: (process.platform === "darwin"
        ? ["openFile", "openDirectory", "multiSelections"]
        : ["openFile", "multiSelections"]) as Array<
        "openFile" | "openDirectory" | "multiSelections"
      >,
    };
    const result = await getOwnerHostServices().ui.pickFiles(options, parentWindow);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    this.lastPickedDirectoryParent = path.dirname(result.filePaths[0]);
    return { canceled: false, entries: classifyReferencePaths(result.filePaths) };
  }

  async listRecentFileReferences(
    request: ListRecentFileReferencesRequest = {},
  ): Promise<ListRecentFileReferencesResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      return await getDesktopFederationRuntime()
        .remoteBackend(request.federationTarget)
        .listRecentFileReferences();
    }
    return {
      files: listRecentFileReferencePaths().map((filePath) => ({
        label: path.basename(filePath),
        path: filePath,
      })),
    };
  }

  async recordRecentFileReferences(
    request: RecordRecentFileReferencesRequest,
  ): Promise<void> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...ownerRequest } = request;
      await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .recordRecentFileReferences(ownerRequest);
      return;
    }
    recordRecentFileReferencePaths(request.paths ?? []);
  }

  async listModelSettingsRecents(
    request: ListModelSettingsRecentsRequest,
  ): Promise<ListModelSettingsRecentsResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...ownerRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .listModelSettingsRecents(ownerRequest);
    }
    return {
      recents: listModelSettingsRecents(request.scope),
    };
  }

  async recordModelSettingsRecent(
    request: RecordModelSettingsRecentRequest,
  ): Promise<void> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...ownerRequest } = request;
      await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .recordModelSettingsRecent(ownerRequest);
      return;
    }
    recordModelSettingsRecent(request.scope, request.recent);
  }

  async registerDirectoryFromDisk(
    request: RegisterDirectoryFromDiskRequest,
  ): Promise<RegisterDirectoryFromDiskResponse> {
    const listDirectoryLaunchpads = () => this.getOverlayStore().listDirectoryLaunchpads();
    const response = await registerDirectoryFromDisk(request, {
      ensureDirectoryLaunchpad: (req) => this.ensureDirectoryLaunchpad(req),
      listDirectoryLaunchpads,
      listRegisteredProjectPaths: process.platform === "darwin" ? async () => {
        const launchpads = await listDirectoryLaunchpads();
        return launchpads.flatMap(({ directoryKey, directoryKind, registeredAt }) =>
          directoryKind === "directory" && registeredAt !== undefined && directoryKey.startsWith("directory:/")
            ? [directoryKey.slice("directory:".length)]
            : []);
      } : undefined,
    });
    if (response.ok) {
      this.lastDirectoriesByKey.set(response.directoryKey, {
        key: response.directoryKey,
        kind: "directory",
        label: response.directoryLabel,
        path: response.directoryPath,
        threadKeys: [],
        needsAttentionCount: 0,
      });
      for (const webContents of subscribersForChannel(
        NAVIGATION_MENTION_SOURCES_CHANGED_EVENT_CHANNEL,
      )) {
        webContents.send(NAVIGATION_MENTION_SOURCES_CHANGED_EVENT_CHANNEL);
      }
    }
    return response;
  }

  async attachDirectoryToThread(
    request: AttachDirectoryToThreadRequest,
  ): Promise<AttachDirectoryToThreadResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...ownerRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .attachDirectoryToThread(ownerRequest);
    }
    const backend = request.backend ?? "codex";
    return await getDesktopBackendRegistry().withThreadWorkspaceMutation({ backend, threadId: request.threadId }, async () => {
      const registered = await this.registerDirectoryFromDisk({
        path: request.path,
        preferredBackend: request.preferredBackend ?? backend,
      });
      if (!registered.ok) {
        return {
          ok: false,
          backend,
          threadId: request.threadId,
          reason: registered.reason,
          message: registered.message,
        };
      }

      const directory = linkedDirectoryForRegistration(registered);
      await getDesktopBackendRegistry().withArchiveWorkspaceWrite([directory.worktreePath ?? directory.path], async () => await this.getOverlayStore().addLinkedDirectory({
        backend,
        threadId: request.threadId,
        directory,
      }));

      await getDesktopBackendRegistry().publishLocalEvent({
        backend,
        notification: {
          method: "navigation/threadDirectories/updated",
          params: {
            reason: "selected-thread",
            threadIds: [request.threadId],
          },
        },
      });

      return {
        ok: true,
        backend,
        threadId: request.threadId,
        directory,
      };
    }, [request.path]);
  }

  async detachDirectoryFromThread(
    request: DetachDirectoryFromThreadRequest,
  ): Promise<DetachDirectoryFromThreadResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...ownerRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .detachDirectoryFromThread(ownerRequest);
    }
    return await detachOwnedThreadDirectory(request, {
      overlayStore: this.getOverlayStore(),
      registry: getDesktopBackendRegistry(),
    });
  }

  async close(): Promise<void> {
    this.unsubscribeRestartGate?.();
    this.unsubscribeRestartGate = undefined;
    this.pendingWakesCache.clear();
    this.ownerNavigationActive = false;
    for (const pending of this.stackPublishActive.values()) pending.abort();
    this.stackPublishAttempts.clear();
    this.stackPublishAwaitingObservation.clear();
    this.ownerNavigationMetadataVersion += 1;
    this.ownerNavigationMetadataAbort?.abort();
    this.prFetcher = undefined;
    this.forgeCiClient = undefined;
    this.localFilePoller?.dispose();
    this.localFilePoller = undefined;
    this.resourceCheckoutPoller?.dispose();
    this.resourceCheckoutPoller = undefined;
    this.unsubscribeResourceCheckouts?.();
    this.unsubscribeResourceCheckouts = undefined;
    this.threadDependencyCiRunPoller?.dispose();
    this.threadDependencyCiRunPoller = undefined;
    this.threadDependencyMergeBuildPoller?.dispose();
    this.threadDependencyMergeBuildPoller = undefined;
    this.ciApprovalPoller?.dispose();
    this.ciApprovalPoller = undefined;
    this.ciApprovalRuns.clear();
    try {
      getThreadTodoService().setCiDeploymentReviewer(undefined);
    } catch {
      // Profile state never opened; nothing was installed.
    }
    this.prPollingScheduler?.stop();
    this.prPollingScheduler = undefined;
    this.prPollingSettingsSyncGeneration += 1;
    this.backgroundPrPollingEnabled = false;
    this.prAutoDispatchAllowed = false;
    this.prAutoDispatchBudgetPaused = false;
    this.prAutoDispatchBudgetPausedAt = undefined;
    if (this.prDiscoveryTimer) {
      clearInterval(this.prDiscoveryTimer);
      this.prDiscoveryTimer = undefined;
    }
    this.prDiscoveryLastRefreshedAt.clear();
    this.prPollingSettingsUnsubscribe?.();
    this.prPollingSettingsUnsubscribe = undefined;
    this.prGraphqlClient = undefined;
    this.githubSamlBlockedRepositories.clear();
    this.prPollingFocus.clear();
    this.transcriptPrSubscriptions.clear();
    this.prPollBackendByKey.clear();
    this.prStatusTransitionListeners.clear();
    this.prAutoDispatchCoordinator?.close();
    this.prAutoDispatchCoordinator = undefined;
    this.prReviewOfferUnsubscribe?.();
    this.prReviewOfferUnsubscribe = undefined;
    this.prReviewOfferCoordinator?.close();
    this.prReviewOfferCoordinator = undefined;
    this.prStatusWatchCoordinator = undefined;
    this.sandboxerPrCleanup = undefined;
    this.attachedPrsByThreadKey.clear();
    this.prDiscoveryAccessByThreadKey.clear();
    this.primaryPrThreadsByKey.clear();
    this.publishedPrimaryGitRepositoriesByThreadKey.clear();
    this.pendingNavigationSnapshots.clear();
    this.remoteNavigationSnapshotCache.clear();
    this.pendingEditCommitResolves.clear();
    this.prStatusRegistry.clear();
    this.prRepositoryAliases.clear();
    this.prRepositoryAliasGeneration = 0;
    this.prWatchKeysGeneration = 0;
    this.prWatchKeySync = Promise.resolve();
    this.prRenameRetryQueued = false;
    this.prReferenceResolutions.clear();
    this.lastPrObservationTimestamp = 0;
    this.threadPullRequestLookup.clear();
    this.prStatusRegistryLoaded = false;
    this.prStatusRegistryLoadPromise = undefined;
    this.directoryGitStatus.clear();
    this.previousDirectoriesByBackend.clear();
    this.lastDirectoriesByKey.clear();
    this.worktreePathByThreadKey.clear();
    this.prRefreshContextByThreadKey.clear();
    await disposeDesktopBackendRegistry();
    await this.threadMigrationService?.dispose();
    this.threadMigrationService = null;
  }

  private getPrFetcher(): ForgePrFetcher {
    if (!this.prFetcher) {
      this.prFetcher = new ForgePrFetcher({
        graphqlClient: this.getPrGraphqlClient(),
        // Read per call, not captured: the operator can toggle a forge
        // while the app runs and the very next poll must respect it.
        isProviderEnabled: (provider) =>
          getDesktopSettingsService().isForgeEnabled(provider),
      }, new GitLabPrFetcher({
        isEnabled: () => getDesktopSettingsService().isForgeEnabled("gitlab"),
        tryTakeRequestToken: () => this.takePrPollingToken("GitLab additional request"),
        getObservationTimestamp: () => this.nextPrObservationTimestamp(),
      }));
    }
    return this.prFetcher;
  }

  private getOverlayStore(): AppServerOverlayStoreLike {
    return getDesktopOverlayStore();
  }

  private getPrAutoDispatchCoordinator(): PrAutoDispatchCoordinator {
    if (!this.prAutoDispatchCoordinator) {
      this.prAutoDispatchCoordinator = new PrAutoDispatchCoordinator({
        store: this.getOverlayStore(),
        registry: getDesktopBackendRegistry(),
        isBackgroundPollingEnabled: () => this.isPrAutoDispatchAvailable(),
        getBudgetConfig: () => this.prAutoDispatchBudgetConfig,
        onActivity: (event) => this.prActivity.record(event),
        stackHold: (pr) => this.prStackHold(pr),
        getCurrentPr: (prKey) => this.prStatusRegistry.get(prKey)?.pr,
        allowsEventKind: (identity, kind) =>
          projectAllowsAutoFixKind(this.threadForgeAutomation(identity), kind),
        handsOff: (identity, pr) => {
          const match = this.prHandsOff(identity, pr);
          return match ? describeHandsOffMatch(match) : undefined;
        },
        refreshPendingPrs: async (pending) =>
          await this.refreshPendingPrAutoDispatches(pending),
        isPrAttached: ({ backend, threadId, prKey }) =>
          this.isPrimaryPrAttached({ backend, threadId, prKey }),
        onPendingChanged: async ({ backend, threadId, pending }) => {
          await getDesktopBackendRegistry().publishLocalEvent({
            backend,
            notification: {
              method: "thread/prAutoDispatch/pendingUpdated",
              params: { threadId, pending },
            },
          });
        },
        onBudgetStatusChanged: (status) => {
          this.updatePrAutoDispatchBudgetStatus(status);
        },
      });
    }
    return this.prAutoDispatchCoordinator;
  }

  /**
   * Review and merge offers for PRs that live threads own; see
   * docs/pr-review-readiness.md. Created with the PR poller, because only its
   * transitions and review changes drive it.
   */
  private ensurePrReviewOfferCoordinator(): void {
    if (this.prReviewOfferCoordinator || !this.backgroundPrPollingEnabled) return;
    let reviews: ReturnType<typeof getThreadReviewService>;
    let todos: ReturnType<typeof getThreadTodoService>;
    try {
      reviews = getThreadReviewService();
      todos = getThreadTodoService();
    } catch (error) {
      // Profile state is not open yet; the next snapshot tries again.
      appServerLog.debug("pr review offers unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const registry = getDesktopBackendRegistry();
    const coordinator = new PrReviewOfferCoordinator({
      liveReviews: () => registry.reviewsInProgress(),
      ownerThread: async (prKey) => await this.prReviewOfferOwner(prKey),
      ineligibleThreads: async (prKey) => ineligiblePrReviewOfferThreads(this.prReviewOfferCandidates(prKey)),
      threadPrKeys: (thread) => {
        const attachment = this.attachedPrsByThreadKey.get(
          buildThreadIdentityKey(thread.backend, thread.threadId),
        );
        return (attachment?.prs ?? [])
          .filter((pr) => this.matchesPrimaryRepository(pr, attachment?.primaryRepoKey))
          .map(getPrStatusKey);
      },
      getPr: (prKey) => this.prStatusRegistry.get(prKey)?.pr,
      neverMergeRefusal: (thread, pr) => this.projectNeverMergeRefusal(thread, pr),
      stackHold: (pr) => this.prStackHoldEvidence(pr),
      stackMergeEvidence: (thread, pr) => this.readStackMergeEvidence(thread, pr),
      isLowerPolled: (key) => this.prPollBackendByKey.has(key) || this.transcriptPrSubscriptions.hasTarget(key),
      directories: (thread, pr) => this.prReviewOfferDirectories(thread, pr),
      listReviews: (thread, pr) => {
        // The owner and every other thread showing the PR, such as a
        // sub-thread the review ran in. Bounded by that PR's thread index.
        const threads = new Map([[buildThreadIdentityKey(thread.backend, thread.threadId), thread]]);
        for (const threadKey of this.primaryPrThreadsByKey.get(getPrStatusKey(pr)) ?? []) {
          const identity = parseThreadIdentityKey(threadKey);
          if (identity) threads.set(threadKey, { backend: identity.backend, threadId: identity.threadId });
        }
        return [...threads.values()].flatMap((candidate) =>
          reviews.list({ ...candidate, status: "all" }, { includeDetached: true })
        );
      },
      recordFixedThrough: (reviewId, commit, settledAt) => {
        reviews.recordFixedThrough(reviewId, commit, settledAt);
      },
      cards: todos,
      identity: new PrChangeIdentityReader(),
      log: (message, fields) => appServerLog.debug(message, fields),
    });
    const unsubscribeReviews = reviews.addChangeListener((review) => {
      coordinator.handleReviewChanged(review);
    });
    const unsubscribeLiveReviews = registry.onLiveReviewChanged((context) => coordinator.handleLiveReviewChanged(context));
    setThreadTodoMergeOfferGate(async (thread, pullRequest) =>
      await this.prMergeOfferRefusal(thread, pullRequest)
    );
    this.prReviewOfferUnsubscribe = () => {
      unsubscribeReviews();
      unsubscribeLiveReviews();
      setThreadTodoMergeOfferGate(undefined);
    };
    this.prReviewOfferCoordinator = coordinator;
  }

  /** The thread's primary attached PR a card's `pullRequest` names, by URL or number. */
  private findPrimaryAttachedPr(
    thread: PrReviewOfferThread,
    pullRequest: string,
  ): PrSummary | undefined {
    const attachment = this.attachedPrsByThreadKey.get(
      buildThreadIdentityKey(thread.backend, thread.threadId),
    );
    const wanted = pullRequest.trim().replace(/\/+$/, "").toLowerCase();
    const number = /^#?(\d+)$/.exec(wanted)?.[1];
    return attachment?.prs.find((pr) =>
      this.matchesPrimaryRepository(pr, attachment.primaryRepoKey)
      && (number ? String(pr.number) === number : pr.url.replace(/\/+$/, "").toLowerCase() === wanted)
    );
  }

  /**
   * Why a thread may not raise a merge card for its PR yet: no review covers
   * the head, or the covering review has unsettled findings. The direct
   * merge_pull_request tool is not gated; the operator approves it.
   */
  private async prMergeOfferRefusal(
    thread: PrReviewOfferThread,
    pullRequest: string,
  ): Promise<string | undefined> {
    const pr = this.findPrimaryAttachedPr(thread, pullRequest);
    // Before the owner and coordinator gates: a never-merge project refuses
    // every merge card, whoever owns the PR's offers.
    const live = pr && (this.prStatusRegistry.get(getPrStatusKey(pr))?.pr ?? pr);
    const neverMerge = this.projectNeverMergeRefusal(thread, live);
    if (neverMerge) return `${neverMerge} This card was not raised.`;
    const coordinator = this.prReviewOfferCoordinator;
    if (!coordinator || !pr) return undefined;
    const hold = await this.prStackHold(pr);
    if (hold) return hold;
    const prKey = getPrStatusKey(pr);
    const owner = await this.prReviewOfferOwner(prKey);
    if (owner?.backend !== thread.backend || owner.threadId !== thread.threadId) return undefined;
    return await coordinator.mergeOfferRefusal(thread, prKey);
  }

  /**
   * Readiness for at most three PRs this thread owns offers for, for its
   * automation status. A thread that does not own a PR's offers gets none,
   * so its guidance never promises an offer.
   */
  private async readPrReviewReadiness(
    thread: PrReviewOfferThread,
    prs: PrSummary[],
  ): Promise<ThreadPullRequestReviewReadiness[]> {
    const coordinator = this.prReviewOfferCoordinator;
    if (!coordinator) return [];
    const readiness: ThreadPullRequestReviewReadiness[] = [];
    for (const pr of prs.slice(0, 3)) {
      const prKey = getPrStatusKey(pr);
      const owner = await this.prReviewOfferOwner(prKey);
      if (owner?.backend !== thread.backend || owner.threadId !== thread.threadId) continue;
      const assessment = await coordinator.assess(thread, prKey, { coverage: true })
        .catch(() => undefined);
      if (!assessment) continue;
      readiness.push({
        prUrl: pr.url,
        prNumber: pr.number,
        readiness: assessment.readiness,
        ...(assessment.headSha ? { headSha: assessment.headSha } : {}),
        reviewed: assessment.headCovered,
        ...(assessment.reviewId ? { reviewId: assessment.reviewId } : {}),
        ...(assessment.openFindings !== undefined ? { openFindings: assessment.openFindings } : {}),
      });
    }
    return readiness;
  }

  /**
   * The one thread a PR's offers go to (`selectPrReviewOfferOwner`): the
   * elected Auto-fix owner when it qualifies, else the first live primary
   * thread. Archived threads, paused projects, and projects with PR offers
   * off get none, and nothing happens while polling is off. Every offer path
   * asks here: cards, the merge-card gate, and readiness guidance.
   */
  private async prReviewOfferOwner(prKey: string): Promise<PrReviewOfferThread | undefined> {
    if (!this.backgroundPrPollingEnabled) return undefined;
    return await selectPrReviewOfferOwner({
      candidates: this.prReviewOfferCandidates(prKey),
      readWinner: async () => await this.getOverlayStore().getPrAutoDispatchCandidateWinner({ prKey }),
    });
  }

  /** Every thread whose primary PR this is, with what decides its offers. */
  private prReviewOfferCandidates(prKey: string): PrReviewOfferCandidate[] {
    const current = this.prStatusRegistry.get(prKey)?.pr;
    const candidates: PrReviewOfferCandidate[] = [];
    for (const threadKey of this.primaryPrThreadsByKey.get(prKey) ?? []) {
      const identity = parseThreadIdentityKey(threadKey);
      if (!identity) continue;
      candidates.push({
        backend: identity.backend,
        threadId: identity.threadId,
        archived: getDesktopBackendRegistry().getThreadInfo(identity)?.archived === true,
        automation: this.threadKeyForgeAutomation(threadKey),
        ...(current && this.prHandsOff(identity, current) ? { handsOff: true } : {}),
      });
    }
    return candidates;
  }

  private prReviewOfferDirectories(thread: PrReviewOfferThread, pr: PrSummary): string[] {
    const prKey = getPrStatusKey(pr);
    const attached = this.attachedPrsByThreadKey
      .get(buildThreadIdentityKey(thread.backend, thread.threadId))
      ?.prs.find((candidate) => getPrStatusKey(candidate) === prKey);
    if (attached?.linkedDirectoryPaths?.length) return attached.linkedDirectoryPaths.slice(0, 4);
    const summary = getDesktopBackendRegistry().getCachedThreadSummary(thread);
    return resolveThreadPullRequestDirectoryPaths({
      linkedDirectories: summary?.linkedDirectories ?? [],
    }).slice(0, 4);
  }

  private getPrStatusWatchCoordinator(): PrStatusWatchCoordinator {
    if (!this.prStatusWatchCoordinator) {
      let archivedSubscriptionsRetired = false;
      this.prStatusWatchCoordinator = new PrStatusWatchCoordinator({
        store: this.getOverlayStore(),
        registry: getDesktopBackendRegistry(),
        isBackgroundPollingEnabled: () => this.backgroundPrPollingEnabled,
        currentPr: (key) => this.prStatusRegistry.get(key)?.pr,
        canStartChecksWake: (thread) => getDesktopBackendRegistry().canStartThreadTurnImmediately(thread),
        stackHold: async (pr) => {
          const hold = await this.prStackHold(pr);
          if (hold) this.prActivity.record({
            category: "repair", source: "PR watch", tone: "warning", message: hold,
            prKeys: [getPrStatusKey(pr)], threadKeys: [...this.primaryPrThreadsByKey.get(getPrStatusKey(pr)) ?? []],
          });
          return hold;
        },
        allowsWatchDispatch: (watch) =>
          getDesktopBackendRegistry().getThreadInfo(watch)?.archived !== true
          && projectAllowsPrWatches(this.threadForgeAutomation(watch)),
        fetchTerminalDetails: async (pr) =>
          await this.getPrFetcher().fetchPullRequestTerminalDetails(pr),
        prepareTerminalWake: async ({ watch }) => {
          const report = await withTimeout(
            this.cleanupThreadSandboxesIfDone(watch.backend, watch.threadId),
            SANDBOX_CLEANUP_WAKE_WAIT_MS,
          );
          if (report === "timeout") {
            return [
              "",
              "Sandbox cleanup by PwrAgent is still running; its result will appear in PR activity.",
            ];
          }
          return formatSandboxCleanupLines(report);
        },
        onWatchesChanged: async (threads) => await this.publishPrWatchesUpdated(threads),
        prepareClaims: async () => {
          if (!archivedSubscriptionsRetired) {
            const retired = await this.getOverlayStore().retireArchivedThreadPrAutomation(Date.now());
            await getDesktopBackendRegistry().publishArchivedThreadAutomationRetirements(retired);
            archivedSubscriptionsRetired = true;
          }
          await this.syncPrStatusWatchKeys();
        },
      });
    }
    return this.prStatusWatchCoordinator;
  }

  private getThreadDependencyCoordinator(): ThreadDependencyCoordinator {
    if (!this.threadDependencyCoordinator) {
      const store = createThreadDependencyStorage();
      this.threadDependencyCoordinator = new ThreadDependencyCoordinator({
        store,
        hasDeliveryReceipt: (dependency) => store.hasDeliveryReceipt(dependency),
        operatorTodos: {
          prepare: (dependency) => readThreadTodoPlacement(getDesktopBackendRegistry(), dependency),
          raise: (card, placement) => getThreadTodoService().raiseForDependency({ ...card, ...placement }).todo,
          publish: (todo) => getThreadTodoService().publish(todo),
        },
        readThread: (condition, automaticMergeBuild) => this.readDependencyThread(condition, automaticMergeBuild),
        authorizeLocalFile: async ({ backend, threadId }, file) => authorizeLocalFile(
          await getDesktopBackendRegistry().resolveThreadWorkspaceCwd(backend, threadId), file),
        readLocalFile,
        observeResourceCheckout: async (dependency) => {
          const service = getResourceCheckoutService();
          const checkout = dependency.conditions[0]?.resourceCheckout;
          if (!service || !checkout) return undefined;
          const actor = service.threadActor(dependency.backend, dependency.threadId);
          const status = await service.status(actor, checkout.resourceId, checkout.requestKey).catch(() => undefined);
          if (!status || status.receipt.outcome !== "queued" || status.state === "queued") return undefined;
          if (status.state === "granted") return {
            state: "satisfied",
            reason: `Allocation ${status.allocationId}, generation ${status.generation}, authority epoch ${status.authorityEpoch}.`,
          };
          return { state: "failed", reason: "The promoted checkout is no longer available to this thread." };
        },
        canClaimLocalFileWake: () => getDesktopBackendRegistry().tryAcquireThreadOwnership(),
        readCiRun: async (url) => await this.readDependencyCiRun(url),
        ciRunUrlOptions: () => this.ciRunUrlOptions(),
        ciRunChecked: (url) => this.getThreadDependencyCiRunPoller().checked(url),
        canonicalizePrUrl: (url) => this.prRepositoryAliases.canonicalizeUrl(url),
        resolvePrUrl: async (url) => await this.resolveCurrentPullRequestUrl(url),
        submit: async (request) => await this.submitDependencyWakeup(request),
        stackHold: async (dependency) => {
          const hold = await this.dependencyCiHold(dependency);
          if (hold) appServerLog.debug("Continue After CI held", { threadId: dependency.threadId, reason: hold });
          return hold;
        },
        recoverCompaction: async (dependency, prompt, canSubmit, admit) => {
          const registry = getDesktopBackendRegistry();
          return await registry.steerCompactionRecovery({
            backend: dependency.backend, threadId: dependency.threadId,
            expectedTurnId: dependency.compaction!.turnId,
            requestId: threadDependencyDeliveryKey(dependency),
            input: [{ type: "text", text: prompt }],
          }, { kind: "pwragent", systemReason: "compaction-recovery",
            dependencyId: threadDependencyDeliveryKey(dependency),
            causalMessagingSource: dependency.causalMessagingSource, causalMessagingAmbiguous: dependency.causalMessagingAmbiguous },
          () => canSubmit() && !this.resolveThreadForgeProject(dependency)?.automation.paused, admit);
        },
        confirmConsumerIdle: async (target) => await this.confirmDependencyConsumerIdle(target),
        // PR conditions also wait while the consumer's project holds PR
        // watches. A paused project's turn-only wake is held or discarded
        // in submit, by its wake-up policy.
        // A quiet restart's continuations go first; the gate opening
        // reconciles again (see `startAppServerOwnerNavigation`).
        canDispatch: (dependency) => this.ownerNavigationActive
          && !getDesktopBackendRegistry().isRestartGateClosed?.()
          && (dependency.conditions.every((condition) => condition.when === "turn_completed" || condition.when === "marked_done" || condition.when === "compaction_completed" || condition.when === "local_file" || condition.when === "resource_checkout")
            || (this.backgroundPrPollingEnabled
              && projectAllowsPrWatches(this.threadForgeAutomation(dependency)))),
        changed: async (dependency) => {
          // A wait that starts, fires or ends changes which runs need checks.
          // After close() the poller is gone; a late change must not rebuild it.
          if (dependency.conditions.some((condition) => condition.ciRun)) {
            this.threadDependencyCiRunPoller?.sync();
            // A delivered approval gate raised a card whose run the owner now follows.
            this.ciApprovalPoller?.sync();
          }
          if (dependency.conditions.some((condition) => condition.when === "merge_build")) this.threadDependencyMergeBuildPoller?.sync();
          if (dependency.conditions.some((condition) => condition.localFile)) this.syncLocalFileChecks();
          if (dependency.conditions.some((condition) => condition.resourceCheckout)) {
            this.syncResourceCheckoutChecks(dependency.status === "waiting" ? 0 : undefined);
          }
          // Prerequisite threads list their dependents, so they refresh too.
          const targets = new Map<string, { backend: AppServerBackendKind; threadId: string }>();
          for (const target of [dependency, ...dependency.conditions.filter(isThreadDependencyLocalThreadCondition)]) {
            targets.set(JSON.stringify([target.backend, target.threadId]), { backend: target.backend, threadId: target.threadId });
          }
          for (const target of targets.values()) {
            await getDesktopBackendRegistry().publishLocalEvent({
              backend: target.backend,
              notification: { method: "thread/dependencies/updated", params: { threadId: target.threadId, dependencyId: dependency.id } },
            });
          }
        },
      });
    }
    return this.threadDependencyCoordinator;
  }

  async prepareResourceCheckoutWakeup(entry: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
  }, id: string): Promise<AppServerTurnInputItem[]> {
    const text = await this.getThreadDependencyCoordinator().resourceCheckoutDeliveryText(entry, id);
    return text ? [{ type: "text", text }] : entry.input;
  }

  async registerResourceCheckoutContinuation(
    context: { backend: AppServerBackendKind; threadId: string; turnId?: string },
    resourceId: string,
    requestKey: string,
    continuation: string,
  ): Promise<ManageThreadDependenciesResponse> {
    return await this.getThreadDependencyCoordinator().manage({
      action: "create", backend: context.backend, threadId: context.threadId, continuation,
      conditions: [{ backend: context.backend, threadId: "", when: "resource_checkout", resourceCheckout: { resourceId, requestKey } }],
    }, await getDesktopBackendRegistry().readCausalMessagingContext(context), "owner:resource-checkout");
  }

  private syncLocalFileChecks(delay?: number): void {
    if (!this.ownerNavigationActive) return;
    const coordinator = this.getThreadDependencyCoordinator();
    this.localFilePoller ??= new LocalFilePoller({
      hasPending: () => coordinator.hasPendingLocalFiles(),
      check: () => coordinator.checkLocalFiles(),
      onError: (error) => appServerLog.warn("Local watcher check failed", { error: String(error) }),
    });
    this.localFilePoller.sync(delay);
  }

  private syncResourceCheckoutChecks(delay?: number): void {
    if (!this.ownerNavigationActive) return;
    const coordinator = this.getThreadDependencyCoordinator();
    this.resourceCheckoutPoller ??= new LocalFilePoller({
      intervalMs: 500,
      hasPending: () => coordinator.hasPendingResourceCheckouts(),
      check: () => coordinator.checkResourceCheckouts(),
      onError: (error) => appServerLog.warn("Resource checkout check failed", { error: String(error) }),
    });
    this.unsubscribeResourceCheckouts ??= getResourceCheckoutService()?.subscribe(() => this.syncResourceCheckoutChecks(0));
    this.resourceCheckoutPoller.sync(delay);
  }

  /**
   * GitHub sends PwrAgent no event for a workflow run until a PwrAgent GitHub
   * App can receive webhooks, so the owner checks each run a wait needs. Runs
   * are read only while PR polling is on and the waiting thread's project
   * allows PR watches, the same gate that holds PR prerequisites.
   */
  private getThreadDependencyCiRunPoller(): ThreadDependencyCiRunPoller {
    this.threadDependencyCiRunPoller ??= new ThreadDependencyCiRunPoller({
      urls: () => this.getThreadDependencyCoordinator().ciRunUrls((dependency) => this.backgroundPrPollingEnabled
        && projectAllowsPrWatches(this.threadForgeAutomation(dependency))),
      read: async (url) => await this.readDependencyCiRun(url),
      observe: async (url, observation) => await this.getThreadDependencyCoordinator().handleCiRunObservation(url, observation),
    });
    return this.threadDependencyCiRunPoller;
  }

  /**
   * A merged PR's build, for `merge_build` waits: the merge commit the forge
   * reports, then every check on it. Read under the same gate as CI runs.
   */
  private getThreadDependencyMergeBuildPoller(): ThreadDependencyCiRunPoller<ThreadDependencyMergeBuildObservation> {
    this.threadDependencyMergeBuildPoller ??= new ThreadDependencyCiRunPoller<ThreadDependencyMergeBuildObservation>({
      urls: () => this.getThreadDependencyCoordinator().mergeBuildUrls((dependency) => this.backgroundPrPollingEnabled
        && projectAllowsPrWatches(this.threadForgeAutomation(dependency))),
      read: async (prUrl) => await this.readDependencyMergeBuild(prUrl),
      failed: (_prUrl, error, code, now) => ({ status: "unknown", error, ...code ? { errorCode: code } : {}, checkedAt: now }),
      observe: async (prUrl, observation) => await this.getThreadDependencyCoordinator().handleMergeBuildObservation(prUrl, observation),
    });
    return this.threadDependencyMergeBuildPoller;
  }

  private async readDependencyMergeBuild(prUrl: string): Promise<ThreadDependencyMergeBuildObservation> {
    const pr = this.getThreadDependencyCoordinator().mergeBuildPullRequest(prUrl);
    const repository = pr && repositoryFromPr(pr.url);
    if (!pr || !repository) throw Object.assign(new Error("The merged PR is no longer known."), { code: "not_found" });
    // Cached per merge, so the forge is asked for the merge commit once.
    const details = await this.getPrStatusWatchCoordinator().resolveTerminalDetails(pr);
    const mergeCommitSha = mergeCommitOf(details);
    const mergedAt = details?.mergedAt ? Date.parse(details.mergedAt) : pr.mergedAt ?? Number.NaN;
    const client = this.getForgeCiClient();
    return await readMergeBuild(async (target, path) => target.provider === "gitlab"
      ? await client.readGitlab(target, path)
      : await client.requestGithub(target, { path }), {
      repository, mergeCommitSha,
      ...details?.baseBranch ?? pr.baseRefName ? { baseBranch: details?.baseBranch ?? pr.baseRefName } : {},
      ...Number.isFinite(mergedAt) ? { mergedAt } : {},
      // A build followed past a cancellation is read where it was left.
    }, Date.now(), this.getThreadDependencyCoordinator().mergeBuildObservation(prUrl));
  }

  /**
   * Reconciles CI approval cards with GitHub. A card raised at a deployment
   * gate stays open until the owner sees the gate cleared or the run end,
   * whoever reviewed it and wherever: PwrAgent, GitHub, or another reviewer.
   * Read under the same gate as CI waits; a check that still waits writes
   * nothing.
   */
  private getCiApprovalPoller(): ThreadDependencyCiRunPoller {
    this.ciApprovalPoller ??= new ThreadDependencyCiRunPoller({
      urls: () => {
        if (!this.backgroundPrPollingEnabled) return [];
        const urls = getThreadTodoService().ciApprovalUrls((todo) => projectAllowsPrWatches(this.threadForgeAutomation(todo)));
        for (const url of this.ciApprovalRuns.keys()) if (!urls.includes(url)) this.ciApprovalRuns.delete(url);
        return urls;
      },
      read: async (url) => await this.readCiApprovalRun(url),
      observe: async (url, observation) => this.observeCiApprovalRun(url, observation),
    });
    return this.ciApprovalPoller;
  }

  private observeCiApprovalRun(url: string, observation: ThreadDependencyCiRunObservation): void {
    // A failed check keeps the last good one: it shows nothing settled.
    if (observation.error) return;
    this.ciApprovalRuns.set(url, observation);
    // The poll syncs its runs when it ends, so a settled card drops out then.
    getThreadTodoService().settleCiApprovals((approval) => {
      const run = this.ciApprovalRuns.get(approval.url);
      return run ? ciApprovalSettled(approval, run) : undefined;
    });
  }

  /** The run and its gates only: an approval card needs no job counts. */
  private async readCiApprovalRun(url: string): Promise<ThreadDependencyCiRunObservation> {
    const ref = parseCiRunUrl(url, this.ciRunUrlOptions());
    if (!ref || ref.repository.provider !== "github") throw new Error(`Not a GitHub Actions run PwrAgent may read: ${CI_RUN_URL_FORMS}.`);
    const client = this.getForgeCiClient();
    return await readGithubRunGates(async (repository, path) => await client.requestGithub(repository, { path, enterpriseCi: true }), ref, Date.now());
  }

  /** Lets CI approval cards approve their gates on this owner's GitHub sign-in. */
  private installCiDeploymentReviewer(): void {
    let todos: ReturnType<typeof getThreadTodoService>;
    try {
      todos = getThreadTodoService();
    } catch (error) {
      appServerLog.debug("deployment reviews unavailable", { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    todos.setCiDeploymentReviewer(async (reviewed) => await this.approveCiDeployment(reviewed));
  }

  /**
   * The operator's Approve, on this owner. The click is the operator's
   * consent, so Ask and Auto need no further card, but the forge policy
   * still binds: forge tools off, or Approve and merge off, refuses it, and
   * GitHub off in Settings → Git refuses it at admission. The run is read
   * again on the same client and sign-in that will write.
   */
  private async approveCiDeployment(reviewed: ReviewThreadTodoCiDeploymentRequest): Promise<{ environments: string[] }> {
    let resolution: ReturnType<typeof resolveForgeAgentToolAccess> | undefined;
    try {
      resolution = resolveForgeAgentToolAccess(getDesktopSettingsService().resolveForgeAgentToolPolicy(), "approve_merge", undefined, undefined);
    } catch (error) {
      // An unreadable policy must not widen access.
      appServerLog.warn("could not read forge policy for a deployment review", { error: String(error) });
    }
    if (!resolution || resolution.level === "off") {
      const setting = resolution?.source === "default"
        ? `${FORGE_AGENT_TOOL_GROUP_LABELS.approve_merge} is Off`
        : resolution ? "Forge tools are off" : "The forge tool setting could not be read";
      throw new CiDeploymentReviewRefusal("not_allowed", `${setting} in Settings → Git → Agent forge tools, so PwrAgent does not approve deployments. Review it on GitHub, or change the setting.`);
    }
    const client = this.getForgeCiClient();
    const approved = await client.withCiDeploymentCredential((request) => approveGithubCiDeployment({
      request,
      reviewed,
      urls: this.ciRunUrlOptions(),
    }));
    appServerLog.info("approved a GitHub deployment gate from a card", {
      repository: reviewed.repository, runId: reviewed.runId, attempt: reviewed.attempt, environments: approved.environments,
    });
    return approved;
  }

  private async readDependencyCiRun(url: string) {
    // Parsed again at every check, so a host the operator removed is no longer read.
    const ref = parseCiRunUrl(url, this.ciRunUrlOptions());
    if (!ref) throw new Error(`Not a CI run PwrAgent may read: ${CI_RUN_URL_FORMS}.`);
    const client = this.getForgeCiClient();
    return await readCiRun(async (repository, path) => repository.provider === "gitlab"
      ? await client.readGitlab(repository, path)
      : await client.requestGithub(repository, { path, enterpriseCi: true }), ref, Date.now());
  }

  private ciRunUrlOptions(): CiRunUrlOptions {
    return { githubEnterpriseHosts: getDesktopSettingsService().resolveGithubEnterpriseHosts() };
  }

  private async dependencyCiHold(dependency: ThreadDependency): Promise<string | undefined> {
    const state = dependency.outcome === "success" ? "satisfied" : "failed";
    for (const entry of dependency.evidence) {
      if (entry.state !== state) continue;
      const { condition } = entry;
      if (condition.when === "ci_run" && condition.ciRun && entry.ciRun?.headSha) {
        const ref = parseCiRunUrl(condition.ciRun.url, this.ciRunUrlOptions());
        if (!ref) continue;
        const repo = githubStackRepository(ref.repository);
        for (const { pr } of this.prStatusRegistry.values()) {
          if (pr.headSha !== entry.ciRun.headSha || isTerminalPullRequest(pr)
            || (entry.ciRun.branch !== undefined && pr.headRefName !== entry.ciRun.branch)
            || `${pr.provider}:${pr.org}/${pr.repo}`.toLowerCase() !== repo) continue;
          const hold = await this.prStackHold(pr);
          if (hold) return hold;
        }
      } else if ((condition.when === "ci_passed" || condition.when === "merge_build") && entry.prUrl) {
        const ref = parsePullRequestReferenceUrl(this.prRepositoryAliases.canonicalizeUrl(entry.prUrl));
        const fresh = ref && this.prStatusRegistry.get(getPrStatusKey({ provider: ref.provider, org: ref.org, repo: ref.repo, number: ref.number }));
        if (!fresh) return "Waiting for fresh CI status for the prerequisite PR";
        if (entry.headSha !== fresh.pr.headSha) return "Waiting for CI evidence for the prerequisite PR's current head";
        if (condition.when === "ci_passed") {
          const current = evaluateCondition(condition, { turns: [], prs: [fresh] }, Date.now(),
            undefined, (url) => this.prRepositoryAliases.canonicalizeUrl(url));
          if (current.state !== entry.state || current.reason !== entry.reason) {
            return "Waiting for fresh CI status for the prerequisite PR";
          }
        }
        if (!isTerminalPullRequest(fresh.pr)) {
          const hold = await this.prStackHold(fresh.pr);
          if (hold) return hold;
        }
      }
    }
  }

  /**
   * A dependency's wake. When the consumer's project is paused, its wake-up
   * policy holds it as a project-held message or discards it with a note;
   * the dependency counts as delivered either way.
   */
  private async submitDependencyWakeup(request: {
    backend: AppServerBackendKind;
    threadId: string;
    input: { type: "text"; text: string }[];
    origin: "automation";
    messageOrigin: import("@pwragent/shared/contracts/normalized-app-server").AppServerThreadMessageOrigin;
    canAdmit?: () => Promise<boolean>;
  }): Promise<{ status: "started" | "queued" | "busy" | "held" | "discarded"; turnId?: string }> {
    const registry = getDesktopBackendRegistry();
    const project = this.resolveThreadForgeProject(request);
    if (request.canAdmit) {
      if (!this.backgroundPrPollingEnabled || !projectAllowsPrWatches(this.threadForgeAutomation(request))) return { status: "busy" };
      const submitted = await registry.submitTurnIfIdle(request);
      return submitted.status === "started" ? { status: "started", turnId: submitted.turnId } : { status: submitted.status };
    }
    // A lock already holds every source, so it wins: the dependency waits
    // for unlock exactly as it does in an active project.
    if (!project?.automation.paused || await registry.isThreadLocked(request)) {
      const submitted = await registry.submitTurnIfIdle({ ...request, joinRunningTurn: true });
      return submitted.status === "started" ? { status: "started", turnId: submitted.turnId } : { status: submitted.status };
    }
    // The prompt's first evidence line names the prerequisite that fired.
    const evidence = (request.input[0]?.text ?? "").split("\n")
      .find((line) => line.startsWith("- "))?.slice(2);
    const delivered = await registry.deliverProjectPausedWakeup({
      ...request,
      project,
      queueEntryId: `dependency:${request.messageOrigin.dependencyId ?? randomUUID()}`,
      source: "dependency",
      summary: summarizeProjectHeldWakeup(`Continue After: ${evidence ?? "prerequisites met"}`),
    });
    return { status: delivered.status === "discarded" ? "discarded" : "held" };
  }

  /**
   * Owner-confirmed idle for a consumer whose busy refusal outlived its idle
   * notification: no turn the registry started, no lock, and no turn in
   * progress in the provider's own latest page of the thread.
   */
  private async confirmDependencyConsumerIdle(target: { backend: AppServerBackendKind; threadId: string }): Promise<boolean> {
    const registry = getDesktopBackendRegistry();
    if (registry.getActiveTurnForThread(target) || await registry.isThreadLocked(target)) return false;
    const response = await registry.readThread({
      ...target, includeTurns: true, limit: 20, viewOnly: true, countsAsActivity: false, preserveAutomaticArchive: true,
    });
    return !response.replay.entries.some((entry) => entry.turn?.status === "in_progress");
  }

  private async readDependencyThread(
    condition: Pick<ThreadDependencyCondition, "backend" | "threadId"> & Partial<ThreadDependencyCondition>,
    automaticMergeBuild?: "recover" | "verified",
  ): Promise<DependencyThreadSnapshot> {
    const registry = getDesktopBackendRegistry();
    const turns = new Map<string, AppServerThreadTurnMetadata>();
    // Use the provider protocol for validation and turn catch-up. PR event
    // evaluation reads only PwrAgent's attachment/status stores.
    if (!condition.when || condition.when === "turn_completed") {
      let before: string | undefined;
      // Pages arrive newest first; keep the turns in provider order.
      const pages: AppServerThreadTurnMetadata[][] = [];
      for (let page = 0; page < 50; page++) {
        const response = await registry.readThread({
          backend: condition.backend, threadId: condition.threadId,
          includeTurns: true, limit: 100, viewOnly: true, preserveAutomaticArchive: true, ...(before ? { before } : {}),
        });
        pages.unshift(response.replay.entries.flatMap((entry) => entry.turn ? [entry.turn] : []));
        const pagination = response.replay.pagination;
        if (!condition.turnId || pages.some((turnsOnPage) => turnsOnPage.some((turn) => turn.id === condition.turnId))
          || !pagination.hasPreviousPage || !pagination.previousCursor || pagination.previousCursor === before) break;
        before = pagination.previousCursor;
      }
      // A turn's latest metadata wins; its first position keeps the order.
      for (const turn of pages.flat()) turns.set(turn.id, turn);
    }
    let prs: PrSummary[] = [];
    if (automaticMergeBuild && condition.when === "merge_build" && condition.prUrl) {
      // A watch already following a merged PR can outlive a checkout move.
      // A legacy wait that never saw its merge still checks its stored attachment.
      const overlay = await this.getOverlayStore().getThreadOverlayState(condition);
      prs = await this.canonicalizeStoredPullRequests(overlay?.prs ?? [], undefined, automaticMergeBuild === "recover");
    } else if (!condition.when || isPrDependencyCondition({ when: condition.when })) {
      prs = (await this.readPrimaryAttachedPrs(condition, false)).prs;
    }
    return {
      activeTurnId: registry.getActiveTurnForThread(condition)?.turnId,
      turns: [...turns.values()],
      prs: prs.map((pr) => {
        const current = this.prStatusRegistry.get(getPrStatusKey(pr));
        return { pr: current?.pr ?? pr, fetchedAt: current?.fetchedAt ?? 0 };
      }),
    };
  }

  /** This instance's active registrations, plus connected peers' for their rows. */
  async listActiveThreadDependencies(): Promise<ManageThreadDependenciesResponse> {
    // Before a profile's state opens there is nothing to list, not an error.
    if (!getAppStateMode()) return { dependencies: [] };
    const dependencies = this.getThreadDependencyCoordinator().active();
    const peerActive = await collectPeerActiveDependencies(getDesktopFederationRuntime());
    return peerActive.length ? { dependencies, peerActive } : { dependencies };
  }

  /**
   * `actor` names who marks a prerequisite done. A request naming a peer's
   * thread goes to that peer; a local `list` also gathers the waits other
   * machines keep on this thread.
   */
  async manageThreadDependencies(request: ManageThreadDependenciesRequest,
    provenance?: Pick<import("@pwragent/shared/contracts/normalized-app-server").AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">,
    actor = "operator"): Promise<ManageThreadDependenciesResponse> {
    // A peer's window reads its owner's registrations, not this machine's.
    if (request?.action === "active" && request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      return await manageRemoteThreadDependencies({ action: "active" }, request.federationTarget,
        (await getDesktopFederationRuntime().health().catch(() => undefined))?.instanceId, getDesktopFederationRuntime());
    }
    if (!request || typeof request.backend !== "string" || !isAppServerBackendKind(request.backend) || typeof request.threadId !== "string" || !request.threadId.trim()) {
      throw new Error("A local backend and waiting threadId are required.");
    }
    if (Object.keys(request).some((key) => ![
      "action", "backend", "threadId", "conditions", "mode", "onFailure", "continuation", "deliver", "handoff",
      "steps", "holdMerge", "dependencyId", "dependencyIds", "conditionIndex", "note", "pullRequest", "federationTarget", "repeat",
      "wakeOn",
    ].includes(key))) throw new Error("Unknown dependency request field.");
    // Reviewed cleanup is the operator's: an agent dismisses one claim it was told about.
    if (request.dependencyIds !== undefined && actor.startsWith("agent:")) {
      throw new Error("dependencyIds is for the operator's reviewed cleanup. Dismiss one reviewed delivery with dependencyId.");
    }
    const { federationTarget, ...owned } = request;
    const runtime = getDesktopFederationRuntime();
    const localInstanceId = (await runtime.health().catch(() => undefined))?.instanceId;
    if (federationTarget && isRemoteFederationTarget(federationTarget) && federationTarget.instanceId !== localInstanceId) {
      // The owner sends the contact's tool calls back here for authorization.
      const source = provenance?.causalMessagingSource;
      return await manageRemoteThreadDependencies(owned, federationTarget, localInstanceId, runtime, {
        ...provenance,
        ...(source ? { causalMessagingSource: { ...source, instanceId: source.instanceId ?? runtime.messagingSourceInstanceId() } } : {}),
      });
    }
    const response = await this.manageLocalThreadDependencies(owned, provenance, actor);
    return owned.action === "list" ? await appendPeerDependents(response, owned as { backend: string; threadId: string }, localInstanceId, runtime) : response;
  }

  /**
   * A peer's Continue After request about this machine's threads. The router
   * already required its turn_control grant, which can read every thread's
   * waits anyway; `active` leaves continuations out, as it does for a window.
   */
  async manageThreadDependenciesForPeer(request: unknown, requesterInstanceId: string | undefined,
    provenance?: import("@pwragent/shared/messaging-causal-context").CausalMessagingContext): Promise<ManageThreadDependenciesResponse> {
    const owned = readFederationThreadDependenciesRequest(request);
    if (!owned) throw new Error("Unknown Continue After action.");
    if (owned.action === "active") {
      return getAppStateMode() ? { dependencies: this.getThreadDependencyCoordinator().active() } : { dependencies: [] };
    }
    const response = await this.manageLocalThreadDependencies(owned, provenance, requesterInstanceId ? `peer:${requesterInstanceId}` : "peer");
    if (owned.action !== "list") return response;
    // Relay the waits other machines, the requester included, keep on this
    // thread; the requester names its own as local.
    const runtime = getDesktopFederationRuntime();
    const localInstanceId = (await runtime.health().catch(() => undefined))?.instanceId;
    return await appendPeerDependents(response, owned as { backend: string; threadId: string }, localInstanceId, runtime);
  }

  private async manageLocalThreadDependencies(request: ManageThreadDependenciesRequest,
    provenance: Pick<import("@pwragent/shared/contracts/normalized-app-server").AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous"> | undefined,
    actor: string): Promise<ManageThreadDependenciesResponse> {
    if (typeof request.backend !== "string" || !isAppServerBackendKind(request.backend) || typeof request.threadId !== "string" || !request.threadId.trim()) {
      throw new Error("A local backend and waiting threadId are required.");
    }
    let normalizedRequest = request;
    if (request.action === "create") {
      validateDependencyCreate(request, () => this.ciRunUrlOptions());
      // The resumed turn starts from this text alone, for the operator's
      // dialog as for an agent's tool call. Accept an operator/peer single
      // self merge_build watch without continuation for older viewers.
      const legacySelfMergeBuild = !actor.startsWith("agent:")
        && request.continuation === undefined
        && (request.deliver === undefined || request.deliver === "agent")
        && request.conditions?.length === 1
        && request.conditions[0]?.when === "merge_build"
        && request.conditions[0].backend === request.backend
        && request.conditions[0].threadId === request.threadId
        && request.conditions[0].target === undefined;
      if (typeof request.continuation !== "string" || !request.continuation.trim()) {
        if (!legacySelfMergeBuild) {
          throw new Error("Write what this thread should do when the prerequisites are met.");
        }
        normalizedRequest = { ...request, continuation: "Report the merge build result." };
      }
      if (request.conditions?.some((condition) => !isAppServerBackendKind(condition?.backend))) throw new Error("Prerequisites must use known local backends.");
      // Validate PR-only prerequisites through the protocol before
      // registration; the coordinator already reads turn and done ones.
      for (const condition of request.conditions ?? []) {
        if (isPrDependencyCondition(condition)) await this.readDependencyThread({ backend: condition.backend, threadId: condition.threadId });
      }
      if (request.conditions?.some(isPrDependencyCondition) && !this.backgroundPrPollingEnabled) {
        throw new Error("Enable background PR polling before waiting for a PR prerequisite.");
      }
      // CI runs are checked under the same switch, so a wait would never fire.
      if (request.conditions?.some((condition) => condition?.when === "ci_run") && !this.backgroundPrPollingEnabled) {
        throw new Error("Enable background PR polling before waiting for a CI run.");
      }
    }
    const { pullRequest, ...managed } = normalizedRequest;
    if (pullRequest !== undefined && (managed.action !== "list" || typeof pullRequest !== "string" || !pullRequest.trim())) {
      throw new Error("pullRequest is a PR number or URL, and only list takes it.");
    }
    const threadId = managed.threadId!.trim();
    const response = await this.getThreadDependencyCoordinator().manage({ ...managed, backend: request.backend, threadId }, provenance, actor);
    if (pullRequest === undefined) return response;
    // The same check a merge from this thread runs, so the card agrees with it.
    const overlay = this.getOverlayStore();
    const readUrls = (thread: { backend: string; threadId: string }) => overlay.readThreadPullRequestUrls(thread as { backend: AppServerBackendKind; threadId: string });
    return {
      ...response,
      mergeHolds: blockingMergeDependencies(createThreadDependencyStorage().active(), {
        backend: request.backend, threadId,
        pullRequest: resolveMergePullRequest(pullRequest, readUrls({ backend: request.backend, threadId })),
      }, readUrls),
    };
  }

  /**
   * An agent's PR prerequisite is stored while the waiting thread's project
   * holds PR watches, and `canDispatch` keeps it waiting until they return.
   * The agent is told why. Turn prerequisites need no notice: their wake is
   * held or discarded by the project's wake-up policy.
   */
  dependencyProjectNotice(request: ManageThreadDependenciesRequest): string | undefined {
    if (
      request?.action !== "create"
      || !request.conditions?.some((condition) => condition && isPrDependencyCondition(condition))
      || typeof request.backend !== "string"
      || !isAppServerBackendKind(request.backend)
      || typeof request.threadId !== "string"
      || !request.threadId.trim()
    ) {
      return undefined;
    }
    const project = this.resolveThreadForgeProject({
      backend: request.backend,
      threadId: request.threadId.trim(),
    });
    if (!project || projectAllowsPrWatches(project.automation)) return undefined;
    return buildProjectPrDependencyNotice({
      projectLabel: project.label,
      paused: project.automation.paused,
    });
  }

  async reconcileThreadDependencies(): Promise<void> {
    if (!getAppStateMode()) return;
    await this.getThreadDependencyCoordinator().reconcile();
    this.getThreadDependencyCiRunPoller().sync();
    this.getThreadDependencyMergeBuildPoller().sync();
    this.getCiApprovalPoller().sync();
    this.syncLocalFileChecks(0);
    this.syncResourceCheckoutChecks(0);
  }

  /**
   * A merge/close wake that found its thread busy is retried when the thread
   * goes idle. The poller no longer fetches the PR, so nothing else would.
   */
  handleAgentEventForPrWatches(event: AgentEvent): void {
    if (!getAppStateMode()) return;
    if (event.federationTarget && isRemoteFederationTarget(event.federationTarget)) return;
    const notification = event.notification as AppServerNotification;
    if (notification.method === "thread/archived") {
      void this.prAutoDispatchCoordinator?.cancelAllPendingForThread({ backend: event.backend, threadId: notification.params.threadId })
        .catch((error) => appServerLog.warn("archived thread repair cancellation failed", { error: String(error) }));
      return;
    }
    const settled = (notification.method === "thread/lock/updated" && !notification.params.lock)
      || notification.method === "turn/completed"
      || notification.method === "turn/failed"
      || notification.method === "turn/cancelled"
      || (
        notification.method === "thread/status/changed"
        && typeof notification.params.status === "object"
        && notification.params.status !== null
        && "type" in notification.params.status
        && notification.params.status.type === "idle"
      );
    if (!settled) return;
    const threadId = (notification.params as { threadId?: string }).threadId?.trim();
    if (!threadId) return;
    void this.retryPendingPrTerminalWatches({ backend: event.backend, threadId })
      .catch((error) => appServerLog.warn("pr terminal watch retry failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      }));
  }

  /**
   * Re-offer cached terminal status to undelivered merge/close watches: for
   * one thread when it goes idle, or for all at startup. A wake interrupted by
   * a busy thread or a quit has no later poll to deliver it, because
   * `collectPrPollTargets` drops a PR once it is merged or closed. A watch
   * whose PR is still open in the cache waits for the poller instead.
   */
  private async retryPendingPrTerminalWatches(
    thread?: { backend: AppServerBackendKind; threadId: string },
  ): Promise<void> {
    if (!this.backgroundPrPollingEnabled) return;
    await this.syncPrStatusWatchKeys();
    // An undelivered event owns its observation. Cache eviction or reopening
    // the PR must not erase a terminal notification held by a thread lock.
    const saved = await this.getOverlayStore().listPendingPrTerminalWatchObservations(thread ?? {});
    const coordinator = this.getPrStatusWatchCoordinator();
    for (const observation of saved) {
      await coordinator.handleTerminalSnapshot(observation.pr, observation.observedAt, { fromSavedObservation: true, pendingOnly: true });
    }
    const prKeys = await this.getOverlayStore()
      .listPendingPrTerminalWatchPrKeys({ ...thread, unobservedOnly: true });
    if (prKeys.length === 0) return;
    await this.loadPrStatusRegistry();
    // Old attachments can predate the durable status registry. Use their
    // saved lifecycle only when no authoritative status observation exists.
    const fallbacks = new Map<string, { pr: PrSummary; fetchedAt: number }>();
    if (prKeys.some((key) => !this.prStatusRegistry.has(key))) {
      const watches = await this.getOverlayStore().listAllActiveThreadPrStatusWatches();
      for (const watch of watches) {
        if (!prKeys.includes(watch.prKey) || this.prStatusRegistry.has(watch.prKey)) continue;
        const overlay = await this.getOverlayStore().getThreadOverlayState(watch);
        const fetchedAt = overlay?.prsFetchedAt ?? 0;
        const pr = this.canonicalizePrs(overlay?.prs ?? []).find((row) => getPrStatusKey(row) === watch.prKey);
        if (pr && (!fallbacks.has(watch.prKey) || fetchedAt > fallbacks.get(watch.prKey)!.fetchedAt)) {
          fallbacks.set(watch.prKey, { pr, fetchedAt });
        }
      }
    }
    for (const prKey of prKeys) {
      const cached = this.prStatusRegistry.get(prKey) ?? fallbacks.get(prKey);
      if (!cached || !isTerminalPullRequest(cached.pr)) continue;
      const dispatched = await coordinator.handleTerminalSnapshot(cached.pr, cached.fetchedAt, { fromSavedObservation: true });
      if (dispatched > 0) {
        appServerLog.info("pr terminal watch completed", {
          prKey,
          watchCount: dispatched,
        });
      }
    }
  }

  handleAgentEventForDependencies(event: AgentEvent): void {
    if (!getAppStateMode()) return;
    if (event.federationTarget && isRemoteFederationTarget(event.federationTarget)) return;
    const notification = event.notification as AppServerNotification;
    let task: Promise<void> | undefined;
    if (event.backend === "codex" && (notification.method === "item/started" || notification.method === "item/completed")) {
      task = this.getThreadDependencyCoordinator().handleCompactionNotification(notification);
    } else if (notification.method === "turn/completed" || notification.method === "turn/failed" || notification.method === "turn/cancelled") {
      // Codex also completes interrupted turns through this method. Missing
      // terminal metadata must reconcile through provider history, not imply success.
      const turn = notification.params.turn;
      const observedStatus = turn && typeof turn === "object" && "status" in turn ? turn.status : undefined;
      const status = typeof observedStatus === "string" && ["completed", "failed", "cancelled", "interrupted"].includes(observedStatus)
        ? observedStatus as AppServerThreadTurnMetadata["status"]
        : notification.method === "turn/failed" ? "failed" : notification.method === "turn/cancelled" ? "cancelled" : undefined;
      const turnId = notification.params.turnId;
      task = this.getThreadDependencyCoordinator().handleThreadEvent(
        { backend: event.backend, threadId: notification.params.threadId },
        status && turnId ? { id: turnId, status } : undefined,
        true,
      );
    } else if (notification.method === "thread/pullRequests/updated") {
      task = this.getThreadDependencyCoordinator().handleThreadEvent({ backend: event.backend, threadId: notification.params.threadId });
    } else if (notification.method === "thread/status/changed") {
      const status = notification.params.status;
      if (status && typeof status === "object" && "type" in status && status.type === "idle") {
        task = this.getThreadDependencyCoordinator().handleThreadEvent({ backend: event.backend, threadId: notification.params.threadId }, undefined, true);
      }
    } else if (notification.method === "thread/turnQueue/updated" && typeof notification.params.status === "string"
      && ["started", "cancelled", "terminal"].includes(notification.params.status)) {
      const coordinator = this.getThreadDependencyCoordinator();
      const { status, threadId, turnId } = notification.params;
      const dependencyId = (notification.params.messageOrigin as import("@pwragent/shared/contracts/normalized-app-server").AppServerThreadMessageOrigin | undefined)?.dependencyId;
      // A continuation that waited in the queue is delivered by its own event.
      const progress = dependencyId && (status === "started" || status === "cancelled")
        ? coordinator.handleDeliveryProgress({ backend: event.backend, threadId, dependencyId, status,
          ...(typeof turnId === "string" ? { turnId } : {}) })
        : Promise.resolve();
      task = status === "started" ? progress
        : progress.then(async () => await coordinator.handleThreadEvent({ backend: event.backend, threadId }, undefined, true));
    } else if (notification.method === "pullRequest/status/updated") {
      const pr = notification.params.pr;
      if (pr && typeof pr === "object" && "url" in pr && typeof pr.url === "string") {
        task = this.getThreadDependencyCoordinator().handlePrEvent(pr.url);
      }
    } else if (notification.method === "thread/lock/updated" && !notification.params.lock) {
      // A lock reads as busy at admission. Unlocking is the consumer's only
      // availability signal when it stays idle.
      task = this.getThreadDependencyCoordinator().handleThreadEvent({ backend: event.backend, threadId: notification.params.threadId }, undefined, true);
    } else if (notification.method === "navigation/providerThreads/refreshed") {
      task = this.getThreadDependencyCoordinator().reconcile();
    }
    void task?.catch((error) => appServerLog.warn("thread dependency evaluation failed", { error: String(error) }));
  }
}

function resolveThreadPullRequestContexts(
  thread: Pick<
    NavigationSnapshot["threads"][number],
    | "gitBranch"
    | "id"
    | "linkedDirectories"
    | "observedGitBranch"
    | "prs"
    | "source"
  >,
): ThreadPrRefreshContext[] {
  const contexts: ThreadPrRefreshContext[] = [];
  const threadBranch =
    thread.observedGitBranch?.trim() || thread.gitBranch?.trim() || "";
  const hasRetainedPrs = (thread.prs?.length ?? 0) > 0;
  const unscopedDirectoryPaths = resolveThreadPullRequestDirectoryPaths({
    linkedDirectories: (thread.linkedDirectories ?? []).filter(
      (directory) => {
        const branch = directory.gitBranch?.trim();
        return !branch || branch === "HEAD";
      },
    ),
  });
  if (threadBranch && unscopedDirectoryPaths.length > 0) {
    contexts.push({
      backend: thread.source,
      threadId: thread.id,
      branch: threadBranch,
      directoryPaths: unscopedDirectoryPaths,
      branchScoped: false,
    });
  }
  const headDirectoryPaths = resolveThreadPullRequestDirectoryPaths({
    linkedDirectories: (thread.linkedDirectories ?? []).filter(
      (directory) => directory.gitBranch?.trim() === "HEAD",
    ),
  });
  if (!threadBranch && hasRetainedPrs && headDirectoryPaths.length > 0) {
    contexts.push({
      backend: thread.source,
      threadId: thread.id,
      branch: "HEAD",
      directoryPaths: headDirectoryPaths,
      branchScoped: false,
    });
  }

  const seenScopedKeys = new Set<string>();
  for (const directory of thread.linkedDirectories ?? []) {
    const branch = directory.gitBranch?.trim();
    const directoryPath = resolvePullRequestDirectoryPath(directory);
    if (!branch || branch === "HEAD" || !directoryPath) {
      continue;
    }
    const key = `${branch}\0${directoryPath}`;
    if (seenScopedKeys.has(key)) {
      continue;
    }
    seenScopedKeys.add(key);
    contexts.push({
      backend: thread.source,
      threadId: thread.id,
      branch,
      directoryPaths: [directoryPath],
      branchScoped: true,
    });
  }

  return contexts;
}

function resolveThreadPullRequestDirectoryPaths(
  thread: Pick<AppServerThreadSummary, "linkedDirectories">,
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const directory of thread.linkedDirectories ?? []) {
    const normalized = resolvePullRequestDirectoryPath(directory);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

/**
 * True when a command string runs a git subcommand that can change the
 * working tree, the index, or local commits (and therefore the
 * dirty/unpushed chips). Mirrors the option-skipping shape of the
 * edited-file-groups commit matcher so `git -C <path> commit` still
 * matches, while a command that merely mentions "commit" later does not.
 */
function commandLooksLikeGitMutation(command: string): boolean {
  return GIT_MUTATION_COMMAND.test(command);
}

const GIT_MUTATION_COMMAND =
  /(?:^|[;&|]\s*)git\s+(?:-{1,2}[\w-]+(?:[= ]\S+)?\s+)*(?:commit|merge|rebase|reset|revert|stash|checkout|switch|restore|cherry-pick|pull|push|am|apply|clean)\b/;

/** Internal owner service; legacy materialization is retained only for unit regression coverage. */
export let appServerService: DesktopAppServerService;

export function initializeDesktopAppServerService(): DesktopAppServerService {
  // Reads the live binding, so a service swapped in by a test answers too.
  setPullRequestBaseLookup((thread, pullRequest) => appServerService?.readThreadPullRequestBaseRef(thread, pullRequest));
  return appServerService ??= new DesktopAppServerService();
}

export function getDesktopAppServerService(): DesktopAppServerService {
  if (!appServerService) throw new Error("getDesktopAppServerService is unavailable before startOwnerServices().");
  return appServerService;
}

/**
 * Test seam: swap in a fresh owner service so no test sees PR registries,
 * caches or budgets an earlier test left behind. Run
 * `disposeAppServerIpcHandlers` first; it closes the outgoing instance.
 * Importers read the live binding, so the IPC handlers use the new instance.
 */
export function resetAppServerServiceForTests(): void {
  appServerService = new DesktopAppServerService();
}

export async function startAppServerOwnerNavigation(): Promise<void> {
  await appServerService.startOwnerNavigation();
  await appServerService.reconcileThreadDependencies();
}

/** A prerequisite that waits on a PR, so it needs background PR polling. */
function isPrDependencyCondition(condition: Pick<ThreadDependencyCondition, "when">): boolean {
  return condition.when === "pr_attached" || condition.when === "ci_passed"
    || condition.when === "pr_merged" || condition.when === "merge_build";
}
