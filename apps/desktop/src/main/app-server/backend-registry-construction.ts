import type { RegistryHandlers } from "./backend-registry-handlers";
import type { RegistryContext } from "./registry-context";
import type { ForgeToolBridge } from "./forge-tool-bridge";
import type { ThreadInspectionTools } from "./thread-inspection-tools";
import type { ThreadMcpConnections } from "./thread-mcp-connections";
import type { ManagedReviewService } from "./managed-review-service";
import type { SubAgentMonitorService } from "./subagent-monitor-service";
import type { ThreadUsageLedger } from "./thread-usage-ledger";
import type { ThreadArchiveCoordinator } from "./thread-archive-coordinator";
import type { ThreadWorkspaceService } from "./thread-workspace-service";
import type { PlanLimitStore } from "./plan-limit-store";
import type { ThreadOwnerAdmission } from "@pwragent/owner-core/thread-owner-admission";
import type { ClaudeBackend, ClaudeBackendOptions } from "../claude/claude-backend";
import type { DesktopCheckoutHibernationPolicy, DesktopThreadArchivePolicy } from "@pwragent/shared";
import type { ArchiveCleanupCheckpointStorage } from "../storage/desktop-runtime-storage";
import type { RestartDispatchPlanOptions } from "./restart-continuation-gate";
import type { CodexModelProviderCatalog } from "./codex-model-provider-catalog";
import type { CodexModelProviderSettings } from "@pwragent/shared";
import type { ThreadCorrespondenceStore } from "./thread-correspondence-store";
import type { PendingEnvironmentLaunchStore } from "./pending-environment-launch-store";
import type { RetainedOwnerThreadStorage } from "@pwragent/owner-core/retained-owner-thread-storage";
import type {
  CreateScheduledThreadActionRequest,
  DesktopProviderModelDefaults,
  DesktopProviderThreadModelMigration,
  DesktopSpendAlertPolicy,
  DesktopToolOutputAlertPolicy,
  LinkedDirectorySummary,
  ScheduledThreadActionMutationResponse,
  DesktopHelperModelSettings,
  DesktopTaskMonitorModelChoice,
} from "@pwragent/shared";
import type {
  AcpBackendAdapter,
  AcpBackendAdapterOptions,
  AcpClientFactory,
  AcpSessionStoreLike,
  AcpTransportFactory,
  LocalAcpDiscovery,
} from "./acp-backend-adapter";
import type { CodexAppServerRecycleSettings } from "../codex-app-server/app-server-recycle-policy";
import type { ThreadSearchService } from "../thread-search/thread-search-service";
import type { PwrAgentAppManagementHandler } from "../agent-tools/pwragent-app-agent-tools";
import type { PwrAgentStarMapHandler } from "../agent-tools/pwragent-star-map-agent-tools";
import type { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import type { TokenMiserHookBridge } from "../token-miser/token-miser-hook-bridge";
import type { TokenMiserPluginManager } from "../token-miser/token-miser-plugin-manager";
import type { TokenMiserDiagnostics } from "../token-miser/token-miser-diagnostics";
import type { TokenMiserService } from "../token-miser/token-miser-service";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import type { AgentToolMcpServerLike } from "../agent-tools/agent-tool-mcp-server";

import type { CodexProtocolCaptureSession } from "../diagnostics/codex-protocol-capture";
import type { ProtocolCaptureStore } from "../testing/capture-store";
import type { GitDirectoryService } from "./git-directory-service";
import type { GitWorkingStateService } from "./git-working-state-service";
import type { ProviderThreadSnapshotStorage } from "@pwragent/owner-core/provider-thread-snapshot-storage";
import type { AcpAvailableCommandsStorage } from "@pwragent/owner-core/acp-storage";
import type { GitWorkspaceHandoffService } from "./git-workspace-handoff-service";
import type { WorktreeArchiveService } from "./worktree-archive-service";
import type { WorktreeRecoveryService } from "./worktree-recovery-service";
import type { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import type { ProviderId } from "../settings/config-store/config-domains";
import type { ManagedCodexSelectionChange } from "../settings/desktop-settings-service";
import type { BackendModelCatalog } from "./backend-model-catalog";
import type { CodexEnvironmentCommandRunner } from "./codex-environment-runtime";
import type { CodexEnvironmentHydrationStoreLike } from "../storage/codex-environment-hydration-store";
import type { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import type { QueuedMessageTitler } from "./queued-message-title";
import type {
  BackendClient,
  BackendRegistryMcpConnectionService,
  BackendRegistryOverlayStoreLike,
  MessagingArchiveCleaner,
  MessagingArchiveCleanupStore,
  ProjectHeldWakeupStoreLike,
  RestartContinuationStoreLike,
  ThreadTitleService,
} from "./backend-registry-types";

export type DesktopBackendRegistryOptions = {
  handlers?: RegistryHandlers;
  ownerAdmission?: ThreadOwnerAdmission;
  getThreadArchivePolicy?: () => DesktopThreadArchivePolicy;
  getCheckoutHibernationPolicy?: () => DesktopCheckoutHibernationPolicy;
  codexClient?: BackendClient;
  overlayStore?: BackendRegistryOverlayStoreLike;
  correspondenceStore?: ThreadCorrespondenceStore;
  pendingEnvironmentLaunchStore?: PendingEnvironmentLaunchStore;
  gitDirectoryService?: GitDirectoryService;
  gitWorkingStateService?: GitWorkingStateService;
  gitWorkspaceHandoffService?: GitWorkspaceHandoffService;
  worktreeArchiveService?: WorktreeArchiveService;
  worktreeRecoveryService?: WorktreeRecoveryService;
  acpAgentStore?: AcpBackendAdapterOptions["acpAgentStore"];
  acpRolloutStore?: AcpBackendAdapterOptions["acpRolloutStore"];
  acpSessionStore?: AcpSessionStoreLike | null;
  acpAvailableCommandsStore?: AcpAvailableCommandsStorage | null;
  providerThreadSnapshotStore?: ProviderThreadSnapshotStorage | null;
  retainedOwnerThreadStorage?: RetainedOwnerThreadStorage | null;
  acpAvailableCommandProbeBudgetMs?: number;
  discoverLocalAcpAgents?: LocalAcpDiscovery;
  /**
   * Opt in to real machine ACP discovery — scanning the operator's machine,
   * and installing/probing a managed Grok build under the PwrAgent root.
   * Only `startOwnerServices()` sets this. Every other construction
   * (all of them in tests) gets `noLocalAcpAgentDiscovery` unless it injects
   * its own `discoverLocalAcpAgents`, so a test cannot reach the machine by
   * forgetting an option.
   */
  useMachineAcpDiscovery?: boolean;
  useMachineClaudeDiscovery?: boolean;
  claudeBackendOptions?: Partial<ClaudeBackendOptions>;
  /** Tests: PwrAgent's worktree roots, which default to ~/.pwragent's. */
  managedWorktreeRoots?: () => Promise<string[]>;
  isAcpAgentEnabled?: (registryId: string) => boolean;
  createAcpClient?: AcpClientFactory;
  /** The transport of an ACP helper's own agent process. */
  createAcpTransport?: AcpTransportFactory;
  /** The cwd of ACP helper sessions; defaults to the profile's helper workspace. */
  resolveAcpHelperWorkspace?: () => Promise<string>;
  agentToolMcpServer?: AgentToolMcpServerLike | null;
  pdfToolMcpServer?: AgentToolMcpServerLike | null;
  mcpConnectionService?: BackendRegistryMcpConnectionService | null;
  messagingStore?: MessagingArchiveCleanupStore | null;
  messagingArchiveCleaner?: MessagingArchiveCleaner | null;
  appManagementHandler?: PwrAgentAppManagementHandler | null;
  starMapHandler?: PwrAgentStarMapHandler | null;
  createScratchProjectDirectory?: () => Promise<string>;
  createScheduledThreadAction?: (
    request: CreateScheduledThreadActionRequest,
    options: { id: string },
  ) => Promise<ScheduledThreadActionMutationResponse>;
  codexEnvironmentCommandRunner?: CodexEnvironmentCommandRunner;
  codexEnvironmentHydrationStore?: CodexEnvironmentHydrationStoreLike;
  threadTitleGenerationService?: ThreadTitleService | null;
  threadSearchService?: ThreadSearchService | null;
  isCodexBootstrapDeferred?: () => boolean;
  isBootstrapMode?: () => boolean;
  resolveCodexDefaultModeRequestUserInput?: () => boolean;
  resolveCodexToolDiscovery?: () => boolean;
  /** Legacy injection accepted for older callers; runMode owns routing. */
  resolveManagedReviewEnabled?: () => boolean;
  resolveDefaultPrAutoDispatchEnabled?: () => boolean;
  resolveProviderModelDefaults?: () => Record<
    string,
    DesktopProviderModelDefaults
  >;
  resolveHelperModelSettings?: () => DesktopHelperModelSettings;
  resolveTaskMonitorModels?: () => Record<string, DesktopTaskMonitorModelChoice>;
  resolvePassSetupVariablesToAgents?: () => boolean;
  resolveUsageAccountGroups?: () => Record<string, string>;
  resolveProviderThreadModelMigrations?: () => Record<
    string,
    DesktopProviderThreadModelMigration
  >;
  resolveCodexFastAllowed?: () => boolean;
  resolveCodexLocalModelIds?: () => string[];
  resolveCodexModelProviders?: () => CodexModelProviderSettings[];
  resolveCodexModelProviderKeys?: () => Promise<Record<string, string>>;
  /** Test seam for provider model discovery; never the network in Vitest. */
  codexModelProviderFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  resolvePdfAnalysisEnabled?: () => boolean;
  resolveTokenMiserEnabled?: () => boolean;
  resolveTokenMiserPollingReviewsEnabled?: () => boolean;
  /** Test seam: how long an ACP session idles before it is closed. */
  acpSessionIdleCloseMs?: number;
  resolveCodexAppServerRecycleSettings?: () => CodexAppServerRecycleSettings;
  /** Test seam: how long a Codex thread idles before it is released. */
  codexThreadIdleUnsubscribeMs?: number;
  configStore?: Pick<DesktopConfigStore, "read" | "subscribe">;
  resolveSpendAlertPolicy?: () => DesktopSpendAlertPolicy;
  resolveToolOutputAlertPolicy?: () => DesktopToolOutputAlertPolicy;
  resolveManagedTokenMiserActivationRequired?: () => boolean;
  resolveCodexDiscoveryPending?: () => boolean;
  markManagedCodexRuntimeSwitchComplete?: () => void;
  /** Overrides the settings service's Codex executable resolution. */
  resolveCodexRuntimeCommand?: () => Promise<{
    command: string;
    version?: string;
  }>;
  watchManagedCodexRuntime?: (
    listener: (
      change: ManagedCodexSelectionChange,
    ) => Promise<unknown> | unknown,
  ) => () => void;
  runtimeInstanceId?: string;
  archiveCleanupCheckpointStore?: ArchiveCleanupCheckpointStorage | null;
  /** `null` keeps held wake-ups in memory only. */
  projectHeldWakeupStore?: ProjectHeldWakeupStoreLike | null;
  /** `null` keeps no restart continuations. */
  restartContinuationStore?: RestartContinuationStoreLike | null;
  /** Batch size, delays, and jitter for continuations. Tests only. */
  restartDispatchPlan?: Omit<RestartDispatchPlanOptions, "now">;
  registrySessionId?: string;
  resolveLiveProfileRuntimeInstanceIds?: () => string[];
  runningTurnShutdownStopTimeoutMs?: number;
  /** How long a queued message waits before it is titled. Tests only. */
  queuedMessageTitleSettleMs?: number;
  acpWorktreeRepositoryResolver?: (
    cwd: string,
    options?: { fresh?: boolean },
  ) => Promise<LinkedDirectorySummary | undefined>;
  };

export interface RegistryDependencies {
  handlers: RegistryHandlers;
  context: RegistryContext;
  forgeToolBridge: ForgeToolBridge;
  threadInspectionTools: ThreadInspectionTools;
  threadMcpConnections: ThreadMcpConnections;
  managedReviewService: ManagedReviewService;
  subAgentMonitorService: SubAgentMonitorService;
  threadUsageLedger: ThreadUsageLedger;
  threadArchiveCoordinator: ThreadArchiveCoordinator;
  threadWorkspaceService: ThreadWorkspaceService;
  ownerAdmission?: ThreadOwnerAdmission;
  configStore?: Pick<
    DesktopConfigStore,
    "read" | "subscribe"
  >;
  runtimeInstanceId: string;
  projectHeldWakeupStore?: ProjectHeldWakeupStoreLike;
  restartContinuationStore?: RestartContinuationStoreLike;
  restartDispatchPlanOptions: Omit<RestartDispatchPlanOptions, "now">;
  registrySessionId: string;
  runningTurnShutdownStopTimeoutMs: number;
  resolveLiveProfileRuntimeInstanceIdsFn: () => string[];
  mcpConnectionService?: BackendRegistryMcpConnectionService;
  providerThreadSnapshotStore?: ProviderThreadSnapshotStorage;
  retainedOwnerThreadStorage?: RetainedOwnerThreadStorage;
  codexProtocolCaptureSession?: CodexProtocolCaptureSession;
  correspondenceStore: ThreadCorrespondenceStore;
  pendingEnvironmentLaunchStore: PendingEnvironmentLaunchStore;
  resolveCodexDefaultModeRequestUserInputFn: () => boolean;
  resolveCodexToolDiscoveryFn: () => boolean;
  resolveDefaultPrAutoDispatchEnabledFn: () => boolean;
  resolveProviderModelDefaultsFn: () => Record<
    string,
    DesktopProviderModelDefaults
  >;
  resolveHelperModelSettingsFn: () => DesktopHelperModelSettings;
  resolveTaskMonitorModelsFn: () => Record<string, DesktopTaskMonitorModelChoice>;
  resolvePassSetupVariablesToAgentsFn: () => boolean;
  resolveUsageAccountGroupsFn: () => Record<string, string>;
  resolveProviderThreadModelMigrationsFn: () => Record<
    string,
    DesktopProviderThreadModelMigration
  >;
  resolveCodexLocalModelIdsFn: () => string[];
  resolveCodexModelProvidersFn: () => CodexModelProviderSettings[];
  resolveCodexModelProviderKeysFn: () => Promise<Record<string, string>>;
  resolveCodexFastAllowedFn: () => boolean;
  resolvePdfAnalysisEnabledFn: () => boolean;
  acpSessionIdleCloseMs: number;
  codexThreadIdleUnsubscribeMs: number;
  resolveTokenMiserEnabledFn: () => boolean;
  resolveCodexAppServerRecycleSettingsFn: () => CodexAppServerRecycleSettings;
  resolveTokenMiserDefaultEnabledFn: () => boolean;
  resolveTokenMiserPollingReviewsEnabledFn: () => boolean;
  resolveManagedTokenMiserActivationRequiredFn: () => boolean;
  markManagedCodexRuntimeSwitchCompleteFn: () => void;
  resolveCodexDiscoveryPendingFn: () => boolean;
  resolveToolOutputAlertPolicyFn: () => DesktopToolOutputAlertPolicy;
  resolveSpendAlertPolicyFn: () => DesktopSpendAlertPolicy;
  spendAlertPolicy: DesktopSpendAlertPolicy;
  toolOutputAlertPolicy: DesktopToolOutputAlertPolicy;
  resolveCodexRuntimeCommandFn?: () => Promise<{
    command: string;
    version?: string;
  }>;
  resolveTokenMiserCodexRuntimeFn?: () => Promise<{
    codexCommand: string;
    codexEnv: NodeJS.ProcessEnv;
  }>;
  codexEnvironmentCommandEnv?: NodeJS.ProcessEnv;
  codexEnvironmentCommandRunner?: CodexEnvironmentCommandRunner;
  codexEnvironmentHydrationStore?: CodexEnvironmentHydrationStoreLike;
  localFilePrivateStorageRoots: readonly string[];
  codexClient: BackendClient;
  tokenMiserDiagnostics?: TokenMiserDiagnostics;
  tokenMiserStore?: TokenMiserStore;
  tokenMiserService?: TokenMiserService;
  tokenMiserHookBridge?: TokenMiserHookBridge;
  tokenMiserCodeModeReducerDescriptorPath?: string;
  tokenMiserStateDir?: string;
  tokenMiserPluginManager?: TokenMiserPluginManager;
  acpWorktreeRepositoryResolver: (
    cwd: string,
    options?: { fresh?: boolean },
  ) => Promise<LinkedDirectorySummary | undefined>;
  acpAvailableCommandsStore?: AcpAvailableCommandsStorage;
  acpAvailableCommandProbeBudgetMs: number;
  overlayStore: BackendRegistryOverlayStoreLike;
  mcpGatewayTools?: McpGatewayToolService;
  gitDirectoryService: GitDirectoryService;
  gitWorkingStateService: GitWorkingStateService;
  worktreeArchiveService: WorktreeArchiveService;
  worktreeRecoveryService: WorktreeRecoveryService;
  pdfToolMcpServer?: AgentToolMcpServerLike;
  claudeAgentToolMcpServer?: AgentToolMcpServerLike;
  claudeBackend: ClaudeBackend;
  acpBackend: AcpBackendAdapter;
  providerRuntimeFingerprints?: Readonly<Record<ProviderId, string>>;
  messagingStore?: MessagingArchiveCleanupStore | null;
  messagingArchiveCleaner?: MessagingArchiveCleaner | null;
  appManagementHandler?: PwrAgentAppManagementHandler;
  starMapHandler?: PwrAgentStarMapHandler;
  resolveAcpHelperWorkspace: () => Promise<string>;
  createScratchProjectDirectory: () => Promise<string>;
  createScheduledThreadActionFn?: (
    request: CreateScheduledThreadActionRequest,
    options: { id: string },
  ) => Promise<ScheduledThreadActionMutationResponse>;
  threadTitleGenerationService?: ThreadTitleService;
  codexModelProviderCatalog: CodexModelProviderCatalog;
  modelCatalog: BackendModelCatalog;
  queuedMessageTitler: QueuedMessageTitler;
  threadTurnQueue: ThreadTurnQueue;
  isCodexBootstrapDeferredFn: () => boolean;
  isBootstrapModeFn: () => boolean;
  planLimits: PlanLimitStore;
  captureStores: ProtocolCaptureStore[];
}
