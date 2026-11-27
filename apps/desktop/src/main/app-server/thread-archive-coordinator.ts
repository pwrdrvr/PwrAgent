import type { RegistryHostPorts } from "./registry-host-ports";
import type { RegistryContext, RegistryHost } from "./registry-context";
import type { RegistryHandlers } from "./backend-registry-handlers";
import { ThreadTurnStartLifecycle } from "@pwragent/owner-core/thread-turn-start-lifecycle";
import type { ThreadWorktreeRegistration } from "@pwragent/shared/contracts/navigation";
import { sweepThreadArchiveRetention, archivedThreadFamily, archiveRetentionFamilyEligible } from "./thread-archive-retention";
import { runGitCommand } from "./git-executable";
import { removeManagedWorktree } from "./managed-worktree";
import { ArchiveWorktreeReferences, canonicalWorktreePaths } from "./archive-worktree-references";
import type { MaintenanceDiscoveryProgress } from "./unreferenced-worktrees";
import { resolveOwnedMaintenanceCheckouts } from "./thread-owned-checkouts";
import { mapMaintenanceAudit } from "./maintenance-audit-pool";
import type { FleetChange } from "./archive-cleanup-fleet-index";
import { ArchiveCleanupInventory, type ArchiveCleanupInventoryHost } from "./archive-cleanup-inventory";
import type { HandoffSourceWorktreeAccess } from "./git-workspace-handoff-service";
import { ArchiveRemovalNeedsFreshInventoryError, ArchiveWorkspaceAdmission, ArchiveWorkspaceOwnership, type ArchiveWorkspaceMutation, type ArchiveWorkspaceObservation } from "./archive-cleanup-workspace-scope";
import { classifyDirectory } from "@pwragent/shared/directory-navigation";
import { type DesktopCheckoutHibernationPolicy } from "@pwragent/shared/checkout-hibernation-policy";
import {
  type DesktopThreadArchivePolicy,
  type DesktopThreadArchiveSweepStatus,
} from "@pwragent/shared/thread-archive-policy";
import type { CodexBackgroundTerminal } from "@pwragent/shared/contracts/background-terminals";
import { ArchiveCleanupReadPool } from "./archive-cleanup-read-pool";
import { ArchiveCleanupQueue, ArchiveCleanupCancelledError, ARCHIVE_CLEANUP_SLICE_SIZE, ARCHIVE_CLEANUP_QUEUE_LIMIT, type ArchiveCleanupContext } from "./archive-cleanup-queue";
import type { ArchiveCleanupCheckpointStorage, ArchiveCleanupIntent } from "../storage/desktop-runtime-storage";
import { PendingEnvironmentLaunchStore } from "./pending-environment-launch-store";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { ArchiveCandidateDiscovery, archiveCandidateCheckpoint, ARCHIVE_CANDIDATE_SLICE_SIZE } from "./archive-candidate-discovery";
import {
  createThreadDependencyStorage,
} from "../storage/desktop-runtime-storage";
import {
  isAppStateInitialized,
} from "../storage/desktop-runtime-storage";
import { runOneTimeArchivedWorktreeRepair } from "../storage/desktop-runtime-storage";
import type {
  ArchivedThreadAutomationRetirement,
} from "../storage/desktop-overlay-store";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";
import {
  type AcpBackendId,
  type ArchiveWorktreeRequest,
  type ArchiveWorktreeResponse,
  type ArchiveThreadRequest,
  type ArchiveThreadCleanupResult,
  type ArchiveThreadResponse,
  type AppServerNotification,
  type AppServerThreadSummary,
  type AppServerBackendKind,
  type CodexThreadEnvironmentRuntime,
  type LinkedDirectorySummary,
  type RestoreWorktreeRequest,
  type RestoreWorktreeResponse,
  type RestoreThreadRequest,
  type RestoreThreadResponse,
  type RestoreThreadWorktreeResult,
  type ThreadHibernatedWorkspace,
  type WorktreeRecoveryFailureReason,
  type WorktreeSnapshotSummary,
  type RemoveLockedThreadWorktreeResponse,
  type RemoveLockedThreadWorktreesRequest,
  type RemoveLockedThreadWorktreesResponse,
  WORKTREE_LOCKED_SKIP_REASON,
  type WorktreeLockedKept,
} from "@pwragent/shared/contracts/normalized-app-server";
import { isToolManagedWorktreePath } from "@pwragent/shared/worktree-paths";
import { type CodexEnvironmentSetupProgressEvent } from "@pwragent/shared/contracts/agent";
import {
  type LaunchpadWorkMode,
  type ThreadMessagingBindingTransition,
  type ThreadOverlayState,
  type SetThreadCheckoutHibernationResponse,
  buildThreadIdentityKey,
  parseThreadIdentityKey,
  isAcpBackendId,
} from "@pwragent/shared/contracts/navigation";
import { type ThreadPullRequestWatchSummary } from "@pwragent/shared/contracts/thread-tools";
import {
  type ThreadMaintenanceRunStage,
  type ThreadMaintenanceRunItem,
} from "@pwragent/shared/thread-maintenance";
import { mergeThreadLinkedDirectories } from "@pwragent/shared/navigation-state";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import {
  ThreadInfoStore,
} from "./thread-info-store";
import { MissingArchiveGitEntryError, MissingArchiveRepositoryError, MissingArchiveWorktreeError, SnapshotLimitExceededError, SnapshotTreeMismatchError, WorktreeArchiveService } from "./worktree-archive-service";
import { WorktreeRecoveryService } from "./worktree-recovery-service";
import { WorktreeLockedError } from "./worktree-volume-lock";
import { isInManagedWorktreeRoot } from "./managed-worktree-ownership";
import { inspectRegisterableWorktree, sameRegisteredWorktree, type CheckoutIdentity } from "./worktree-maintenance-registration";
import { protectiveMaintenanceWatches, type MaintenancePrObservation } from "./maintenance-pr-watches";
import { runMaintenanceItems } from "./maintenance-runner";
import { describeHibernatedThreadWorkspace, primaryThreadWorktree } from "./missing-thread-workspace";
import {
  HIBERNATION_KEEP_REASONS,
  hibernationKeepReason,
  checkoutHibernationLastActivity,
  hibernationTarget,
  isArchivedCheckoutCandidate,
  type HibernationContext,
} from "./checkout-hibernation";
import { HIBERNATION_WORKSPACE_KEEP_REASONS, inspectHibernationWorkspace } from "./checkout-hibernation-workspace";
import { CheckoutPathOwners, isArchivedCheckoutOwner } from "./checkout-path-owners";
import { hasWorktreeTerminalsOpenIn } from "../terminal/worktree-terminals";
import { WorktreeContainerService, type WorktreeContainerCleanup } from "./worktree-container-service";
import { ARCHIVE_ACTIVE_SUB_AGENT_STATUSES, ThreadArchiveSweeper, type ThreadArchiveCandidate } from "./thread-archive-sweeper";
import { maintenanceKeptThread } from "./maintenance-checkout-owners";
import { getDesktopMessagingStore } from "../messaging/desktop-messaging-store";
import { getMainLogger } from "../log";
import {
  listCodexEnvironmentOptions,
} from "./codex-environment-config";
import {
  CodexEnvironmentStartupError,
} from "./codex-environment-runtime";
import {
  ThreadTurnQueue,
} from "@pwragent/owner-core/thread-turn-queue";
import type { ThreadAssetOwner } from "./thread-assets";
import {
  readStatusType,
} from "./backend-registry-notifications";
import {
  type ArchiveCleanupMetadata,
  type ArchiveWorktreeRemovalAdmission,
  type ArchivedWorktreeRepairReport,
  type BackendClient,
  type MessagingArchiveCleaner,
  type MessagingArchiveCleanupResult,
  type MessagingArchiveCleanupStore,
  type PendingServerRequest,
  type WorktreeArchiveCandidate,
  type WorktreeRestoreCandidate,
} from "./backend-registry-types";
import {
  THREAD_LIST_REUSE_WINDOW_MS,
  isCodexMissingRolloutArchiveError,
  pathExists,
} from "./backend-registry-runtime-helpers";
import {
  readNonEmptyString,
  readRecord,
} from "./backend-registry-notification-values";
import {
  isHandoffDirectory,
  linkedDirectoryWorktreePath,
  normalizeWorktreePathForComparison,
  resolveThreadWorkspaceCwd,
  withRetainedWorktrees,
} from "./linked-directory-identity";
import {
  AutomaticArchiveCancelledError,
  CheckoutHibernationKeptError,
  MISSING_REPOSITORY_SKIP_REASON,
  MISSING_WORKTREE_SKIP_REASON,
  REVIEWED_SNAPSHOT_LIMIT_TTL_MS,
  archiveNotificationWorkspacePaths,
  archiveWorkspacePaths,
  archivedWorktreeKeptReasons,
} from "./thread-archive-helpers";

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

/** A reviewed removal named one archived thread, but another owns the checkout now. */
const ARCHIVED_OWNER_CHANGED_REASON = "Now belongs to a different archived thread";

/** The refusals a hibernated restore answers with a detached HEAD instead. */
const DETACHED_RESTORE_REASONS: Partial<Record<WorktreeRecoveryFailureReason,
  NonNullable<WorktreeSnapshotSummary["detachedFrom"]>["reason"]>> = {
  "branch-checked-out": "in-use",
  "branch-moved": "moved",
  "branch-missing": "missing",
};

/** Codex rows, and the summaries built from ACP sessions, carry no archive
 * time even on the archived page. Which page listed a thread is its archive
 * state. The sentinel marks presence only; no caller reads the value. */
function withListedArchiveState(thread: AppServerThreadSummary, archived: boolean): AppServerThreadSummary {
  return { ...thread, archivedAt: archived ? thread.archivedAt ?? 1 : undefined };
}

/** The policies, roots and stores the composition root supplies to this module. */
export interface ThreadArchiveCoordinatorDependencies {
  readonly managedMaintenanceRoots: () => Promise<string[]>;
  readonly readThreadArchivePolicy: () => DesktopThreadArchivePolicy;
  readonly readCheckoutHibernationPolicy: () => DesktopCheckoutHibernationPolicy;
  readonly archiveCleanupCheckpointStore?: ArchiveCleanupCheckpointStorage;
  readonly worktreeContainerService: WorktreeContainerService;
}

/** The handler binding messaging supplies once the registry bridge exists. */
export type ThreadArchiveCoordinatorHandlers = Pick<RegistryHandlers, "messagingArchiveCleaner">;

/**
 * Registry-owned state and operations the archive coordinator reads. The
 * registry's construction ports satisfy it; this module never imports the
 * registry. Codex turn activity, the thread lifecycle locks, handoff
 * reservations and pending started threads stay registry-owned.
 */
export interface ThreadArchiveCoordinatorHost extends Pick<RegistryHostPorts,
  "getCachedThreadSummary" | "getClient" | "publishLocalEvent" | "threadHasActiveTurn"
  | "resolveThreadEnvironmentCwd" | "withCodexThreadClient" | "withGoalHibernation"
>, ArchiveCleanupInventoryHost {
  deleteOwnedThreadAssets(owner: ThreadAssetOwner): Promise<void>;
  readonly codexBackgroundTerminals: ReadonlyMap<string, CodexBackgroundTerminal[]>;
  readonly messagingStore?: MessagingArchiveCleanupStore | null;
  readonly pendingEnvironmentLaunchStore: PendingEnvironmentLaunchStore;
  readonly pendingServerRequests: ReadonlyMap<string, PendingServerRequest>;
  readonly pendingStartedThreads: Map<string, AppServerThreadSummary>;
  readonly resolveLiveProfileRuntimeInstanceIdsFn: () => string[];
  readonly stoppingRunningTurnsForShutdown: boolean;
  readonly subAgentStartupReconciliation: Promise<void>;
  readonly threadHandoffReservations: ReadonlySet<string>;
  readonly threadInfoStore: ThreadInfoStore;
  readonly threadLifecycleLocks: PerKeyAsyncLock;
  readonly threadListCacheOwnerId: string;
  readonly threadStarts: ThreadTurnStartLifecycle;
  readonly threadTurnQueue: ThreadTurnQueue;
  readonly tokenMiserStore?: TokenMiserStore;
  readonly worktreeArchiveService: WorktreeArchiveService;
  readonly worktreeRecoveryService: WorktreeRecoveryService;
  buildForkedCodexEnvironmentRuntime(params: {
    cwd?: string;
    owner?: { backend: AppServerBackendKind; threadId: string };
    /** Run setup in a workspace that is not a new worktree. */
    forceSetup?: boolean;
    onSetupProgress?: (
      event: Omit<CodexEnvironmentSetupProgressEvent, "directoryKey">,
    ) => void;
    sourceRuntime?: CodexThreadEnvironmentRuntime;
    workMode: LaunchpadWorkMode;
  }): Promise<CodexThreadEnvironmentRuntime | undefined>;
  listAllInstalledAcpThreads(
    filter?: string,
    archived?: boolean,
  ): Promise<AppServerThreadSummary[]>;
  threadHasBlockingWorkspaceMove(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): boolean;

}

/**
 * The archive, hibernation and restore domain of the backend registry: the
 * inactive-thread sweeper and archive retention, checkout hibernation and its
 * single-flight restores, archive and restore of threads and worktrees, the
 * paced archive cleanup queue with its quit checkpoints and fleet index, the
 * archive workspace ownership fences every directory writer passes through,
 * and the messaging cleanup that follows an archive.
 */
export class ThreadArchiveCoordinator {
  private readonly context: RegistryContext;
  private readonly host: RegistryHost<ThreadArchiveCoordinatorHost>;
  readonly cleanupInventory: ArchiveCleanupInventory;

  constructor(
    context: RegistryContext,
    dependencies: ThreadArchiveCoordinatorDependencies,
    handlers: ThreadArchiveCoordinatorHandlers,
    host: RegistryHost<ThreadArchiveCoordinatorHost>,
  ) {
    this.context = context;
    this.host = host;
    this.cleanupInventory = new ArchiveCleanupInventory(context, host, () => this.archiveWorkspaceRevision);
    this.managedMaintenanceRoots = dependencies.managedMaintenanceRoots;
    this.readThreadArchivePolicy = dependencies.readThreadArchivePolicy;
    this.readCheckoutHibernationPolicy = dependencies.readCheckoutHibernationPolicy;
    this.archiveCleanupCheckpointStore = dependencies.archiveCleanupCheckpointStore;
    this.worktreeContainerService = dependencies.worktreeContainerService;
    this.messagingArchiveCleaner = handlers.messagingArchiveCleaner;
  }

  /** Running restores by thread, for the turn queue's busy check. */
  get checkoutRestoreRecords(): ReadonlyMap<string, Promise<void>> {
    return this.checkoutRestores;
  }

  /** Lifecycle mutations in flight by thread, for the registry's live-event check. */
  get threadLifecycleMutationCountRecords(): ReadonlyMap<string, number> {
    return this.threadLifecycleMutationCounts;
  }

  /** Cleanups waiting beyond the bounded queue, for the registry's shutdown. */
  get archiveCleanupOverflowRecords(): ReadonlyMap<string, unknown> {
    return this.archiveCleanupOverflow;
  }

  /** Worktree removals holding admission, for the registry's notification path. */
  get archiveWorktreeRemovalAdmissionRecords(): ReadonlySet<ArchiveWorktreeRemovalAdmission> {
    return this.archiveWorktreeRemovalAdmissions;
  }

  /** The registry's thread-list read compares this before and after listing. */
  archiveCleanupReadGeneration(backend: AppServerBackendKind): number {
    return this.archiveCleanupReads.generation(backend);
  }

  /** A turn start refuses a thread whose workspace an archive owns. */
  assertArchiveWorkspaceUsable(key: string): void {
    this.archiveWorkspaceOwnership.assertUsable(key);
  }

  /** A workspace change the registry observed fences in-flight admissions. */
  advanceArchiveWorkspaceRevision(): void {
    this.archiveWorkspaceRevision += 1;
  }

  /** Cancels every automatic archive reserving this checkout, and returns their keys. */
  cancelCheckoutHibernations(worktreePath: string): string[] {
    const hibernations: string[] = [];
    for (const [key, reservation] of this.automaticArchiveReservations) {
      if (!reservation.worktreePath || normalizeWorktreePathForComparison(reservation.worktreePath) !== normalizeWorktreePathForComparison(worktreePath)) continue;
      reservation.cancelled = true;
      hibernations.push(key);
    }
    return hibernations;
  }

  /** Drains the physical cleanup queue at shutdown. */
  closeArchiveCleanupQueue(): Promise<void> {
    return this.archiveCleanupQueue.close();
  }

  /** Stops the inactive-thread sweeper at shutdown. */
  stopThreadArchiveSweeper(): Promise<void> | undefined {
    const discovery = this.candidateDiscovery.close();
    const sweep = this.threadArchiveSweeper?.stop();
    // Preserve idle shutdown's existing boundary. Only add a drain barrier
    // when discovery actually owns work.
    return discovery ? Promise.all([sweep, discovery]).then(() => {}) : sweep;
  }

  private readonly worktreeContainerService: WorktreeContainerService;

  private messagingArchiveCleaner?: MessagingArchiveCleaner | null;

  private readonly archivedMessagingCleanupInFlight = new Map<
    string,
    Promise<MessagingArchiveCleanupResult>
  >();

  private readonly archivedMessagingCleanupCompleted = new Set<string>();

  private readonly archivedMessagingCleanupGeneration = new Map<string, number>();

  private readonly activeObservationsByBackend = new Map<AppServerBackendKind, Map<string, number>>();

  private readonly observedActiveThreadWorkspaces = new Map<string, {
    projectKey: string;
    linkedWorktrees: Set<string>;
  }>();

  private readonly archiveWorktreeRemovalAdmissions = new Set<ArchiveWorktreeRemovalAdmission>();

  private readonly archiveWorkspaceOwnership = new ArchiveWorkspaceOwnership(() =>
    [...this.archiveWorktreeRemovalAdmissions].map((admission) => admission.scope),
  );

  private readonly archiveLifecycleMutationPaths = new Map<string, Set<readonly string[]>>();

  private readonly archiveCleanupReads = new ArchiveCleanupReadPool(THREAD_LIST_REUSE_WINDOW_MS);

  private archiveCleanupProgressVisible = false;

  private archiveCleanupProgressSignature?: string;

  private readonly archiveCleanupQueue = new ArchiveCleanupQueue<ArchiveThreadResponse>(undefined, () => {
    this.drainArchiveCleanupOverflow();
    this.dispatchReleasedArchiveCleanups(this.archiveWorktreeReferences.readyIntents());
    // A drained queue ends its batch; the next batch reads the fleet afresh.
    if (!this.archiveCleanupQueue.pendingKeys().length && !this.archiveCleanupOverflow.size) this.cleanupInventory.clearBatch();
  }, () => {
    if (this.context.lifecycle.closed) return;
    // The physical queue also paces audits, hourly repair and recovery. Only
    // newly requested archives belong in the archive action progress notice.
    const progress = this.archiveCleanupQueue.progress(true);
    const overflow = [...this.archiveCleanupOverflow.values()].filter((job) => !job.resuming).length;
    const params = {
      batchId: `${this.host().runtimeInstanceId}:${progress.batch}`,
      active: progress.active.flatMap(({ key, worktreePath }) => {
        const identity = parseThreadIdentityKey(key);
        return identity ? [{ backend: identity.backend, threadId: identity.threadId, ...(worktreePath ? { worktreePath } : {}) }] : [];
      }),
      queued: progress.queued + overflow,
      completed: progress.completed,
      total: progress.total + overflow,
    };
    // Audits/recovery have no action progress. Still clear an earlier action
    // if its terminal update was coalesced with the start of a silent batch.
    if (params.total === 0 && !this.archiveCleanupProgressVisible) return;
    const signature = JSON.stringify(params);
    if (signature === this.archiveCleanupProgressSignature) return;
    this.archiveCleanupProgressSignature = signature;
    this.archiveCleanupProgressVisible = params.active.length > 0 || params.queued > 0;
    void this.context.emit({ backend: "codex", notification: {
      method: "archiveCleanup/progress", params,
    } }).catch((error: unknown) => backendRegistryLog.warn("archive cleanup progress publication failed", { error: String(error) }));
  });

  /** Cleanups beyond the bounded physical queue, in arrival order. Each keeps
   * its intent in `pendingArchiveCleanupIntents`, so quit checkpoints it. */
  private readonly archiveCleanupOverflow = new Map<string, {
    intent: ArchiveCleanupIntent; resuming: boolean;
    resolve: (response: ArchiveThreadResponse) => void; reject: (error: unknown) => void;
    promise: Promise<ArchiveThreadResponse>;
  }>();

  private readonly archiveRepairOwners = new Map<string, string>();

  private readonly archiveCleanupCheckpointStore?: ArchiveCleanupCheckpointStorage;

  private readonly archiveWorktreeReferences = new ArchiveWorktreeReferences();

  private readonly archiveReferenceReleaseRevisions = new Map<string, number>();

  private readonly archiveReferenceNotificationWork = new WeakMap<AppServerNotification, Promise<void>>();

  private readonly releasedArchiveReferenceKeys = new Set<string>();

  private readonly archiveReferenceIdentities = new Map<string, { backend: AppServerBackendKind; threadId: string }>();

  private readonly canonicalArchiveOwnership = new WeakMap<AppServerThreadSummary[], Promise<{
    active: Map<string, AppServerThreadSummary[]>;
    unknown: AppServerThreadSummary[];
    external: Map<string, Set<AppServerThreadSummary>>;
  }>>();

  private readonly pendingArchiveCleanupIntents = new Map<string, ArchiveCleanupIntent>();

  /** Recovered jobs whose discovery failed. Checkpoint for the next startup,
   * without treating them as running quit work or retrying in this process. */
  private readonly archiveCleanupRetryIntents = new Map<string, ArchiveCleanupIntent>();

  private archiveCleanupResumeStarted = false;

  private archivedWorktreeRepair?: Promise<ArchivedWorktreeRepairReport>;

  /** Orders deferred ownership observations against reference releases. */
  private archiveWorkspaceRevision = 0;

  /** Additions (reference rows plus queued intents) at the last checkpoint. */
  private archiveCheckpointedAdditions = -1;

  /** Counts cleanup intents queued, so a boundary persists new queued work. */
  private archiveCleanupIntentAdditions = 0;

  private readonly threadArchiveOperations = new Map<string, Promise<ArchiveThreadResponse>>();

  private readonly archiveCleanupCompletions = new Map<string, { promise: Promise<ArchiveThreadResponse>; archivedAt: number }>();

  private readonly cancelledArchiveCleanupKeys = new Set<string>();

  private readonly archiveCleanupNotifications = new WeakSet<AppServerNotification>();

  private readonly automaticArchiveReservations = new Map<string, { cancelled: boolean; worktreePath?: string }>();

  private readonly threadLifecycleMutationCounts = new Map<string, number>();

  private threadArchiveSweeper?: ThreadArchiveSweeper;

  private readonly candidateDiscovery = new ArchiveCandidateDiscovery(async (progress, signal) =>
    await this.readAutoArchiveCandidates(progress, signal));

  /** In-memory, per-thread approvals from a reviewed maintenance run to
   * snapshot past the normal size limit. Never persisted: a restart drops
   * them, and the cleanup retry then keeps the checkout. */
  private readonly reviewedSnapshotLimits = new Map<string, { bytes: number; expiresAt: number }>();

  private readonly threadArchiveSweepStatusListeners = new Set<(status: DesktopThreadArchiveSweepStatus) => void>();

  private readonly readThreadArchivePolicy: () => DesktopThreadArchivePolicy;

  private readonly readCheckoutHibernationPolicy: () => DesktopCheckoutHibernationPolicy;

  private readonly managedMaintenanceRoots: () => Promise<string[]>;

  /** Single-flight restores of hibernated checkouts. Concurrent sends share
   * one, and the turn queue treats the thread as busy until it settles. */
  private readonly checkoutRestores = new Map<string, Promise<void>>();
  private readonly checkoutRecoveryLocks = new PerKeyAsyncLock();

  /** The last failed restore per thread. Memory only: a failed restore writes
   * nothing, and the next attempt or a relaunch tries again. */
  private readonly checkoutRestoreFailures = new Map<string, { worktreePath: string; message: string }>();

  /** Failures the next queued dispatch reports instead of retrying at once. */
  private readonly undeliveredCheckoutRestoreFailures = new Set<string>();

  /** What a running restore has done so far, for the thread card. Memory
   * only; it outlives the snapshot record while setup runs. */
  private readonly checkoutRestoreProgress = new Map<string, ThreadHibernatedWorkspace>();

  // Messaging needs the registry bridge before it can supply these bindings.
  setMessagingArchiveCleaner(
    cleaner: MessagingArchiveCleaner | null | undefined,
  ): void {
    this.messagingArchiveCleaner = cleaner;
  }

  startThreadArchiveSweeper(): void {
    if (!this.context.lifecycle.closed) this.getThreadArchiveSweeper().start();
  }

  async sweepInactiveThreads(options: { manual?: boolean } = {}): Promise<void> {
    if (!this.context.lifecycle.closed) await this.getThreadArchiveSweeper().sweep({ manual: options.manual ?? true });
  }

  getThreadArchiveSweepStatus(): DesktopThreadArchiveSweepStatus {
    return this.getThreadArchiveSweeper().getStatus();
  }

  onThreadArchiveSweepStatusChanged(
    listener: (status: DesktopThreadArchiveSweepStatus) => void,
  ): () => void {
    this.threadArchiveSweepStatusListeners.add(listener);
    return () => { this.threadArchiveSweepStatusListeners.delete(listener); };
  }

  /** Complete active and archived membership from every provider, including
   * native children. Concurrent exploratory callers share only this pass;
   * it projects no navigation state and makes no SQLite commits. */
  listAutoArchiveCandidates(onProgress?: (progress: MaintenanceDiscoveryProgress) => void, signal?: AbortSignal): Promise<ThreadArchiveCandidate[]> {
    return this.candidateDiscovery.list(onProgress, signal);
  }

  private async readAutoArchiveCandidates(onProgress?: (progress: MaintenanceDiscoveryProgress) => void,
    signal?: AbortSignal, assertAdmission: () => void = () => {}): Promise<ThreadArchiveCandidate[]> {
    await this.host().subAgentStartupReconciliation;
    if (this.context.lifecycle.closed || this.host().isBootstrapModeFn()) return [];
    const checkpoint = archiveCandidateCheckpoint(() => {
      if (this.context.lifecycle.closed || signal?.aborted) throw new ArchiveCleanupCancelledError();
      assertAdmission();
    }, undefined, signal);
    // Use complete provider reads without navigation projection or display
    // persistence. An idle hourly sweep must make no SQLite commits.
    onProgress?.({ detail: "Reading Codex threads and native children" });
    const codexThreads: AppServerThreadSummary[] = [];
    if (!this.host().isCodexBootstrapDeferredFn()) {
      if (!this.context.providers.codex.listArchiveCleanupThreadsPage) throw new Error("Complete Codex maintenance discovery is unavailable.");
      for (const archived of [false, true]) {
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          await checkpoint(true);
          const page = await this.context.providers.codex.listArchiveCleanupThreadsPage({
            archived, cursor, limit: 100, checkpoint, rowCheckpoint: checkpoint, directoryFilter: async () => false,
          });
          await checkpoint();
          codexThreads.push(...page.threads.map((thread) => withListedArchiveState(thread, archived)));
          onProgress?.({ detail: "Reading Codex checkout owners, including archived threads and native children", found: codexThreads.length });
          cursor = page.nextCursor?.trim();
          if (cursor && cursors.has(cursor)) throw new Error("Codex maintenance discovery returned a repeated cursor.");
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
    }
    // Read provider membership without navigation enrichment or its durable
    // caches. A failed provider is an incomplete safety inventory, not zero
    // checkout users. Include children regardless of their parent's machine.
    const threads = [...codexThreads];
    for (const backendId of await this.context.providers.acp.archiveCleanupBackendIds()) {
      onProgress?.({ detail: `Reading ${backendId} threads`, found: threads.length });
      for (const archived of [false, true]) {
        let after: string | undefined;
        do {
          await checkpoint(true);
          const page = this.context.providers.acp.listArchiveCleanupSessionsPage(backendId, { archived, after, limit: ARCHIVE_CANDIDATE_SLICE_SIZE });
          threads.push(...page.sessions.map((session) => withListedArchiveState(this.context.providers.acp.sessionToThreadSummary(session), archived)));
          if (page.nextCursor && after && page.nextCursor <= after) throw new Error("ACP maintenance discovery did not advance.");
          after = page.nextCursor;
        } while (after);
      }
    }
    onProgress?.({ detail: "Reading Claude threads", found: threads.length });
    for (const archived of [false, true]) {
      await checkpoint(true);
      threads.push(...await this.context.providers.claude.listThreads({ archived }));
    }
    await checkpoint(true);
    const workspaceObservations = new Map<string, Promise<LinkedDirectorySummary | undefined>>();
    // One read for every thread a PR watch will wake.
    const activePrWatches = await this.context.stores.pullRequests.listAllActivePrStatusWatches();
    const savedPrStatuses = activePrWatches.length ? await this.readMaintenancePrStatuses() : [];
    const mergeHeldThreadKeys = this.readMergeHeldThreadKeys();
    const watchesByThread = new Map<string, ThreadPullRequestWatchSummary[]>();
    for (const watch of activePrWatches) {
      const key = buildThreadIdentityKey(watch.backend, watch.threadId);
      const group = watchesByThread.get(key) ?? [];
      group.push(watch);
      watchesByThread.set(key, group);
    }
    const candidates: ThreadArchiveCandidate[] = [];
    // A failed read keeps only the threads it covers, never the whole list.
    const unreadable = (error: unknown, backend: AppServerBackendKind, threadId?: string) => {
      backendRegistryLog.warn("auto-archive candidate state read failed; the thread is kept", {
        backend, threadId, error: error instanceof Error ? error.message : String(error),
      });
    };
    const byBackend = new Map<AppServerBackendKind, Map<string, AppServerThreadSummary>>();
    for (const thread of threads) {
      await checkpoint();
      if (!byBackend.has(thread.source)) byBackend.set(thread.source, new Map());
    }
    for (const archived of [true, false]) for (const thread of threads) {
      await checkpoint();
      if ((thread.archivedAt !== undefined) === archived) byBackend.get(thread.source)!.set(thread.id, thread);
    }
    for (const [backend, byId] of byBackend) {
      // A thread can move between the active and archived reads. Active
      // membership wins, so an ambiguous row still protects its checkout.
      const backendThreads = [...byId.values()];
      for (let offset = 0; offset < backendThreads.length; offset += ARCHIVE_CANDIDATE_SLICE_SIZE) {
        await checkpoint(true);
        const slice = backendThreads.slice(offset, offset + ARCHIVE_CANDIDATE_SLICE_SIZE);
        const threadIds = slice.map((thread) => thread.id);
        let overlays: Record<string, ThreadOverlayState | undefined> | undefined;
        let activeSubAgentIds: Set<string> | undefined;
        try {
          overlays = this.context.stores.threads.getThreadListingOverlayStates
            ? await this.context.stores.threads.getThreadListingOverlayStates({ backend, threadIds, withPrAutoDispatchPending: true })
            : await this.context.stores.threads.getThreadOverlayStates({ backend, threadIds });
        } catch (error) { unreadable(error, backend); }
        await checkpoint();
        try {
          activeSubAgentIds = new Set(await this.context.stores.subAgents.listArchiveActiveSubAgentThreadIds({
            backend, threadIds, statuses: ARCHIVE_ACTIVE_SUB_AGENT_STATUSES,
          }));
        } catch (error) { unreadable(error, backend); }
        for (const thread of slice) {
          await checkpoint();
          onProgress?.({ detail: `Resolving ${backend} checkout ownership`, found: candidates.length, root: thread.projectKey });
          const watches = await this.maintenancePrWatches(watchesByThread.get(buildThreadIdentityKey(backend, thread.id)) ?? [],
            overlays?.[thread.id], savedPrStatuses);
          const activePrWatch = watches.length > 0;
          const mergeHeld = mergeHeldThreadKeys.has(buildThreadIdentityKey(backend, thread.id));
          if (!overlays) {
            candidates.push({ thread, activePrWatch, activePrWatches: watches, mergeHeld, unreadable: true });
            continue;
          }
          try {
            const resolved = await this.maintenanceThreadWorkspace(thread, overlays[thread.id], workspaceObservations);
            candidates.push({
              thread: resolved, overlay: overlays[thread.id],
              activeSubAgent: activeSubAgentIds?.has(thread.id),
              ...(!activeSubAgentIds ? { unreadable: true } : {}),
              activePrWatch,
              activePrWatches: watches,
              mergeHeld,
            });
          } catch (error) {
            unreadable(error, backend, thread.id);
            candidates.push({ thread, overlay: overlays[thread.id], activePrWatch, activePrWatches: watches, mergeHeld, unreadable: true });
          }
        }
      }
    }
    await checkpoint(true);
    for (let offset = 0; offset < candidates.length; offset += ARCHIVE_CANDIDATE_SLICE_SIZE) {
      await checkpoint(true);
      await this.markFinishedMonitorWorkers(candidates.slice(offset, offset + ARCHIVE_CANDIDATE_SLICE_SIZE));
    }
    // Ownership is a checkout-wide decision. Resolve the complete inventory
    // before admitting any receipt, including external owners already archived.
    const ownership: Pick<ArchiveCleanupMetadata, "activeThreads" | "archivedThreads"> = { activeThreads: [], archivedThreads: [] };
    for (let offset = 0; offset < candidates.length; offset += ARCHIVE_CANDIDATE_SLICE_SIZE) {
      await checkpoint();
      const slice = this.maintenanceOwnershipInventory(candidates.slice(offset, offset + ARCHIVE_CANDIDATE_SLICE_SIZE));
      ownership.activeThreads.push(...slice.activeThreads);
      ownership.archivedThreads.push(...slice.archivedThreads);
    }
    const observations = new Map<string, Promise<boolean>>();
    for (const candidate of candidates) {
      await checkpoint();
      if (candidate.unreadable) continue;
      try {
        candidate.managedWorktreePath = await this.managedMaintenanceCheckout(candidate.thread, ownership, observations);
      } catch (error) {
        candidate.unreadable = true;
        unreadable(error, candidate.thread.source, candidate.thread.id);
      }
    }
    await checkpoint();
    return candidates;
  }

  /** Marks the finished PwrAgent monitor workers in one read. A worker from
   * before workers became ephemeral is an unarchived provider thread in its
   * parent's checkout; unmarked, it keeps that checkout shared forever. A
   * failed read marks none, so every worker stays a checkout user. */
  private async markFinishedMonitorWorkers(candidates: ReadonlyArray<{ thread: Pick<AppServerThreadSummary, "id" | "source">;
    finishedMonitorWorker?: boolean; }>): Promise<void> {
    const finished = await this.finishedMonitorWorkerKeys(candidates.map((candidate) => candidate.thread));
    for (const candidate of candidates) {
      if (finished.has(buildThreadIdentityKey(candidate.thread.source, candidate.thread.id))) candidate.finishedMonitorWorker = true;
    }
  }

  /** Identity keys of the given threads that are finished monitor workers.
   * A failed read returns none, so every worker stays a checkout user. */
  private async finishedMonitorWorkerKeys(threads: ReadonlyArray<Pick<AppServerThreadSummary, "id" | "source">>): Promise<Set<string>> {
    if (!this.context.stores.archive.listFinishedMonitorWorkerThreadKeys || threads.length === 0) return new Set();
    try {
      return new Set(await this.context.stores.archive.listFinishedMonitorWorkerThreadKeys(
        threads.map((thread) => buildThreadIdentityKey(thread.source, thread.id))));
    } catch (error) {
      backendRegistryLog.warn("finished monitor worker read failed; workers stay checkout users", {
        error: error instanceof Error ? error.message : String(error),
      });
      return new Set();
    }
  }

  private maintenanceOwnershipInventory(candidates: readonly ThreadArchiveCandidate[], current?: ThreadArchiveCandidate):
    Pick<ArchiveCleanupMetadata, "activeThreads" | "archivedThreads"> {
    const owners = new Map(candidates.map((candidate) => [buildThreadIdentityKey(candidate.thread.source, candidate.thread.id), candidate]));
    if (current) owners.set(buildThreadIdentityKey(current.thread.source, current.thread.id), current);
    const activeThreads: AppServerThreadSummary[] = [];
    const archivedThreads: AppServerThreadSummary[] = [];
    for (const candidate of owners.values()) {
      const { thread, overlay } = candidate;
      const linkedDirectories = withRetainedWorktrees(
        mergeThreadLinkedDirectories([...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []]), overlay,
      );
      (isArchivedCheckoutOwner(candidate) ? archivedThreads : activeThreads).push({ ...thread, linkedDirectories });
    }
    return { activeThreads, archivedThreads };
  }

  /** Provider cwd summaries are intentionally minimal. Resolve their current
   * checkout from Git metadata on every maintenance read, independently of
   * which threads navigation has previously opened. Never persists a cache. */
  async maintenanceThreadWorkspace(
    thread: AppServerThreadSummary,
    overlay: ThreadOverlayState | undefined,
    observations = new Map<string, Promise<LinkedDirectorySummary | undefined>>(),
  ): Promise<AppServerThreadSummary> {
    const cwd = resolveThreadWorkspaceCwd(thread, overlay?.extraLinkedDirectories ?? []);
    if (!cwd) return thread;
    const observationKey = normalizeWorktreePathForComparison(cwd);
    let observation = observations.get(observationKey);
    if (!observation) {
      observation = this.host().acpWorktreeRepositoryResolver(cwd, { fresh: true });
      observations.set(observationKey, observation);
    }
    const observed = await observation;
    if (!observed) return thread;
    // Git uses forward slashes on Windows; maintenance also receives native
    // filesystem paths. Keep one spelling for review keys and coverage.
    const directory = { ...observed, path: path.normalize(observed.path),
      ...(observed.worktreePath ? { worktreePath: path.normalize(observed.worktreePath) } : {}) };
    // Explicit external ownership wins over filesystem classification.
    const external = [...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []]
      .some((item) => item.worktreeOwnership === "external"
        && [cwd, directory.worktreePath!].some((target) =>
          normalizeWorktreePathForComparison(item.worktreePath ?? item.path) === normalizeWorktreePathForComparison(target)));
    const resolvedPaths = new Set([cwd, directory.worktreePath!].map(normalizeWorktreePathForComparison));
    return { ...thread, linkedDirectories: [
      { ...directory, ...(external ? { worktreeOwnership: "external" as const } : {}) },
      ...thread.linkedDirectories.filter((item) => !resolvedPaths.has(normalizeWorktreePathForComparison(item.worktreePath ?? item.path))),
    ] };
  }

  private async isManagedMaintenanceCheckout(worktreePath: string): Promise<boolean> {
    return await isInManagedWorktreeRoot(worktreePath, await this.managedMaintenanceRoots());
  }

  private async readMaintenancePrStatuses(): Promise<MaintenancePrObservation[] | null> {
    try { return Object.values(await this.context.stores.pullRequests.readPrStatusCache()); }
    catch (error) {
      backendRegistryLog.warn("maintenance PR observations unavailable; watches remain protective", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async maintenancePrWatches(
    watches: ThreadPullRequestWatchSummary[],
    overlay: ThreadOverlayState | undefined,
    saved?: readonly MaintenancePrObservation[] | null,
  ): Promise<ThreadPullRequestWatchSummary[]> {
    if (!watches.length) return [];
    const cached = saved === undefined ? await this.readMaintenancePrStatuses() : saved;
    if (cached === null) return watches;
    return protectiveMaintenanceWatches(watches, [
      ...(overlay?.prs ?? []).map((pr) => ({ pr, fetchedAt: overlay?.prsFetchedAt ?? 0 })), ...cached,
    ]);
  }

  /** The resolver above established a linked checkout and this thread's
   * attachment. A legacy external flag cannot veto our canonical root;
   * outside roots, only an explicit, still-valid registration can override it. */
  private async managedMaintenanceCheckout(
    thread: AppServerThreadSummary,
    ownership?: Pick<ArchiveCleanupMetadata, "activeThreads" | "archivedThreads">,
    observations = new Map<string, Promise<boolean>>(),
  ): Promise<string | undefined> {
    const directory = primaryThreadWorktree(thread);
    if (!directory || directory.worktreeOwnership !== "external") return undefined;
    let observation = observations.get(directory.worktreePath);
    if (!observation) {
      observation = ownership ? this.isManagedArchiveCheckout(ownership, directory.worktreePath)
        : this.isManagedMaintenanceCheckout(directory.worktreePath);
      observations.set(directory.worktreePath, observation);
    }
    return await observation ? directory.worktreePath : undefined;
  }

  /** Threads a Continue After wait holds from merging; auto-archive keeps them. */
  private readMergeHeldThreadKeys(): Set<string> {
    if (!isAppStateInitialized()) return new Set();
    return new Set(createThreadDependencyStorage().active()
      .filter((dependency) => dependency.holdMerge && (dependency.status === "waiting" || dependency.status === "ready"))
      .map((dependency) => buildThreadIdentityKey(dependency.backend, dependency.threadId)));
  }

  /** The project a candidate counts toward: its main checkout. */
  async resolveAutoArchiveProject({ thread, overlay }: ThreadArchiveCandidate): Promise<string | undefined> {
    const directory = [...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []][0];
    // Scratch projects share one quota per projects root, matching their
    // single Workspaces row. Each would otherwise be its own project and
    // never reach the per-project limit.
    const descriptor = directory ? classifyDirectory(directory) : undefined;
    if (descriptor?.kind === "workspace") return descriptor.key;
    const cwd = directory?.worktreePath ?? directory?.path;
    if (!cwd) return thread.projectKey;
    try {
      // Constant output per checkout. Listing every worktree made one scan
      // quadratic in a repository's worktree count. Git's primary checkout is
      // the common directory without its trailing /.git, or the common
      // directory itself for a bare or separate Git dir.
      const { stdout } = await runGitCommand(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 10_000 });
      const commonDirectory = stdout.trim();
      if (!commonDirectory) return directory?.path ?? thread.projectKey;
      return path.basename(commonDirectory) === ".git" ? path.dirname(commonDirectory) : commonDirectory;
    } catch {
      // The managed checkout may already be gone; its linked repository
      // still identifies the project without making each old worktree a quota.
      return directory?.path ?? thread.projectKey;
    }
  }

  private getThreadArchiveSweeper(): ThreadArchiveSweeper {
    return this.threadArchiveSweeper ??= new ThreadArchiveSweeper({
      cleanupWorktrees: async ({ manual, onProgress, onFailure }) => {
        const publishProgress = (completed: number, report: ArchivedWorktreeRepairReport) => onProgress({
          candidates: report.candidates.length, protected: report.protectedWorktrees,
          processed: Math.min(completed, report.candidates.length),
          removed: report.cleanup.filter((item) => item.removedWorktree).length,
          emptyContainers: report.emptyContainerCandidates.length,
          processedContainers: Math.max(0, completed - report.candidates.length),
          removedContainers: report.containerCleanup.filter((item) => item.removed).length,
          kept: archivedWorktreeKeptReasons(report),
        });
        const repair = async () => await this.repairArchivedThreadWorktrees({
          onProgress: (completed, _total, report) => {
            if (report) publishProgress(completed, report);
          },
        });
        const report = isAppStateInitialized()
          ? await runOneTimeArchivedWorktreeRepair({ repair, force: manual })
          : manual ? await repair() : undefined;
        if (!report) return;
        publishProgress(report.candidates.length + report.emptyContainerCandidates.length, report);
        for (const item of [...report.cleanup, ...report.containerCleanup]) {
          if (item.error) onFailure(new Error(item.error), { path: item.worktreePath });
        }
      },
      cleanupRetention: async (onFailure) => await this.sweepArchivedThreadRetention(onFailure),
      listCandidates: async (signal) => await this.listAutoArchiveCandidates(undefined, signal),
      hibernation: {
        getPolicy: () => this.readCheckoutHibernationPolicy(),
        keepReason: (candidate, candidates, policy, now, owners) =>
          this.checkoutHibernationKeepReason(candidate, candidates, policy, now, owners),
        inspectWorkspace: async (worktreePath, policy, signal) => (await inspectHibernationWorkspace(worktreePath, {
          signal, limitBytes: policy.maxSnapshotMb * 1024 * 1024, removeRebuildableOutput: policy.removeRebuildableOutput,
        })).keep,
        hibernate: async (candidate, policy) => await this.hibernateIdleCheckout(candidate, policy),
      },
      onError: (error, threadId) => backendRegistryLog.warn("hourly thread sweep failed", {
        threadId, error: error instanceof Error ? error.message : String(error),
      }),
      onStatus: (status) => {
        for (const listener of this.threadArchiveSweepStatusListeners) listener(status);
      },
    });
  }

  private async listThreadsForArchiveRetention(): Promise<AppServerThreadSummary[]> {
    await this.host().subAgentStartupReconciliation;
    if (this.context.lifecycle.closed || this.host().isBootstrapModeFn() || this.host().isCodexBootstrapDeferredFn()) {
      throw new Error("Archive retention discovery is unavailable during startup.");
    }
    if (!this.context.providers.codex.listNativeSubAgentThreads) throw new Error("Complete descendant discovery is unavailable.");
    const groups = await Promise.all([false, true].map(async (archived) => {
      const lists = await Promise.all([
        this.context.providers.codex.listThreads({ archived, enrichDirectories: false, skipArchivedMetadataRefresh: true, requireComplete: true }, { callerReason: "auto-archive" }),
        this.context.providers.codex.listNativeSubAgentThreads!({ all: true, archived }, { callerReason: "auto-archive" }),
        this.host().listAllInstalledAcpThreads(undefined, archived),
        this.context.providers.claude.listThreads({ archived, requireComplete: true }),
      ]);
      return lists.flat().map((thread) => withListedArchiveState(thread, archived));
    }));
    // A thread can move between the two reads. Active membership wins: an
    // ambiguous inventory must never authorize permanent deletion.
    return [...new Map([...groups[1]!, ...groups[0]!].map((thread) => [buildThreadIdentityKey(thread.source, thread.id), thread])).values()];
  }

  private async sweepArchivedThreadRetention(onFailure: (error: unknown) => void): Promise<number> {
    if (!this.context.stores.archive.listThreadArchiveStates || !this.context.stores.archive.observeArchivedThreads
      || !this.context.stores.archive.forgetThreadArchiveStates) return 0;
    return await sweepThreadArchiveRetention({
      getPolicy: () => this.readThreadArchivePolicy(),
      listThreads: async () => await this.listThreadsForArchiveRetention(),
      listStates: async () => await this.context.stores.archive.listThreadArchiveStates!(),
      ...(this.context.stores.archive.listThreadArchiveStatesFor ? {
        listStatesFor: async (threads: ThreadOverlayState[], snapshotRefs: string[]) =>
          await this.context.stores.archive.listThreadArchiveStatesFor!(threads, snapshotRefs),
      } : {}),
      shouldStop: () => this.context.lifecycle.closed || this.host().stoppingRunningTurnsForShutdown,
      observeArchives: async (threads, now) => await this.observeArchivedThreads(
        threads.map((thread) => ({ backend: thread.source, threadId: thread.id })), now),
      confirmAbsent: async (state) => {
        if (state.backend === "claude") {
          const absent = await this.context.providers.claude.confirmThreadAbsent(state.threadId);
          if (absent) await this.host().deleteOwnedThreadAssets(state);
          return absent;
        }
        if (isAcpBackendId(state.backend)) {
          const absent = !this.context.providers.acp.getSession(state.backend, state.threadId);
          if (absent) await this.host().deleteOwnedThreadAssets(state);
          return absent;
        }
        return await this.host().withCodexThreadClient(state.threadId, async (client) => {
          if (!client.readThreadSummary) return false;
          try { await client.readThreadSummary(state.threadId); return false; }
          catch (error) {
            // Only an explicit provider not-found response confirms deletion.
            // Transport errors, unloaded threads and profile changes retain refs.
            const absent = error instanceof Error && error.message.toLowerCase().includes("thread not found:");
            if (absent) await this.host().deleteOwnedThreadAssets(state);
            return absent;
          }
        });
      },
      deleteFamily: async (family, policy) => await this.deleteExpiredThreadFamily(family, policy),
      deleteSnapshot: async (snapshot) => await this.host().worktreeArchiveService.deleteSnapshot(snapshot),
      forgetStates: async (states) => await this.context.stores.archive.forgetThreadArchiveStates!(states),
      isBusy: (candidate) => this.autoArchiveCandidateIsBusy(candidate),
      onError: (error, threadId) => {
        if (error instanceof AutomaticArchiveCancelledError) return;
        backendRegistryLog.warn("archived thread retention cleanup failed", {
          threadId, error: error instanceof Error ? error.message : String(error),
        });
        onFailure(error);
      },
    });
  }

  private async deleteExpiredThreadFamily(candidates: ThreadArchiveCandidate[], policy: DesktopThreadArchivePolicy): Promise<void> {
    const reservation = { cancelled: false };
    const keys = candidates.map(({ thread }) => buildThreadIdentityKey(thread.source, thread.id)).sort();
    for (const key of keys) this.automaticArchiveReservations.set(key, reservation);
    const withLocks = async (index: number): Promise<void> => {
      if (index < keys.length) return await this.host().threadLifecycleLocks.run(keys[index]!, async () => await withLocks(index + 1));
      const root = candidates[0]!.thread;
      const run = async (remove: (threadId: string) => Promise<unknown>) => {
        const threads = await this.listThreadsForArchiveRetention();
        const currentRoot = threads.find((thread) => thread.source === root.source && thread.id === root.id);
        if (!currentRoot) throw new AutomaticArchiveCancelledError();
        const family = archivedThreadFamily(currentRoot, threads);
        if (family.map((thread) => buildThreadIdentityKey(thread.source, thread.id)).sort().join("\n") !== keys.join("\n")) {
          throw new AutomaticArchiveCancelledError();
        }
        const current = await Promise.all(family.map(async (thread) => {
          const fresh = await this.refreshAutoArchiveCandidate({ thread });
          if ((fresh.thread.updatedAt ?? 0) > (thread.updatedAt ?? 0)) throw new AutomaticArchiveCancelledError();
          return fresh;
        }));
        if (reservation.cancelled || JSON.stringify(this.readThreadArchivePolicy()) !== JSON.stringify(policy)
          || !archiveRetentionFamilyEligible(current, policy, (candidate) => this.autoArchiveCandidateIsBusy(candidate), Date.now())) {
          throw new AutomaticArchiveCancelledError();
        }
        await remove(root.id);
        // The provider deletes the complete family. Child notifications may
        // be missed, so release every owner's assets before forgetting refs.
        for (const thread of family) {
          await this.host().deleteOwnedThreadAssets({ backend: thread.source, threadId: thread.id });
        }
        this.host().invalidateThreadListCache(root.source);
        for (const thread of family) this.invalidateArchiveCleanupReads(thread.source, undefined, true, thread.id, [], "deleted");
      };
      if (isAcpBackendId(root.source)) {
        const backend = root.source;
        await run(async (threadId) => {
          this.context.providers.acp.deleteStoredSession(backend, threadId);
          await this.context.emit({ backend, notification: { method: "thread/deleted", params: { threadId } } });
        });
      } else if (root.source === "claude") {
        await run(async (threadId) => await this.context.providers.claude.deleteThread(threadId));
      } else {
        await this.host().withCodexThreadClient(root.id, async (client) => {
          if (!client.deleteThread) throw new Error("This provider does not support permanent thread deletion.");
          await run(async (threadId) => await client.deleteThread!({ threadId }));
        });
      }
    };
    try { await withLocks(0); }
    finally { for (const key of keys) this.automaticArchiveReservations.delete(key); }
  }

  cancelAutomaticArchive(backend: AppServerBackendKind, threadId: string): void {
    const reservation = this.automaticArchiveReservations.get(buildThreadIdentityKey(backend, threadId));
    if (reservation) reservation.cancelled = true;
  }

  /** Operator intent cancels pending housekeeping before waiting on its lock.
   * Once the provider mutation starts, conflicting operations wait for cleanup.
   * Archive can finish mutation admission before awaiting owned cleanup; other
   * callers release admission when their work returns. */
  async withThreadLifecycleMutation<T>(
    identity: { backend?: AppServerBackendKind; threadId: string; sourcePath?: string; targetPath?: string; repositoryPath?: string; worktreePath?: string },
    work: (finishMutation: (archived?: true) => void) => Promise<T>,
    archiving = false,
  ): Promise<T> {
    const backend = identity.backend ?? "codex";
    const key = buildThreadIdentityKey(backend, identity.threadId);
    this.archiveWorkspaceOwnership.assertUsable(key, true);
    this.archiveWorkspaceRevision += 1;
    const paths = [identity.sourcePath, identity.targetPath, identity.repositoryPath, identity.worktreePath]
      .filter((value): value is string => Boolean(value));
    const scopes = this.archiveLifecycleMutationPaths.get(key) ?? new Set<readonly string[]>();
    scopes.add(paths);
    this.archiveLifecycleMutationPaths.set(key, scopes);
    this.recordArchiveWorkspaceChange(key, paths, false, archiving);
    // Record intent synchronously, before yielding to a provider admission.
    this.cancelAutomaticArchive(backend, identity.threadId);
    const archival = this.threadArchiveOperations.get(key);
    if (archival) this.cancelledArchiveCleanupKeys.add(key);
    this.threadLifecycleMutationCounts.set(key, (this.threadLifecycleMutationCounts.get(key) ?? 0) + 1);
    let mutationFinished = false;
    const finishMutation = (archived?: true) => {
      if (mutationFinished) return;
      mutationFinished = true;
      // An admission can start while this mutation is already pending and
      // read its old provider row. Settling must fence that observation too.
      this.archiveWorkspaceRevision += 1;
      this.recordArchiveWorkspaceChange(key, paths, false, archiving);
      if (archived) {
        for (const { scope } of this.archiveWorktreeRemovalAdmissions) scope.archiveSettled(key);
      }
      scopes.delete(paths);
      if (!scopes.size) this.archiveLifecycleMutationPaths.delete(key);
      const remaining = (this.threadLifecycleMutationCounts.get(key) ?? 1) - 1;
      if (remaining) this.threadLifecycleMutationCounts.set(key, remaining);
      else this.threadLifecycleMutationCounts.delete(key);
    };
    try {
      await this.cancelAndWaitArchiveCleanups(key);
      if (archival) {
        // An inverse intent can arrive while the provider mutation is still in
        // flight. Let that mutation settle, then cancel any newly queued cleanup
        // before starting the inverse operation.
        await archival.catch(() => {});
        await this.cancelAndWaitArchiveCleanups(key);
        this.cancelledArchiveCleanupKeys.delete(key);
      }
      if (this.automaticArchiveReservations.has(key)) {
        // Wait only for housekeeping. Holding this lock across operator work
        // would deadlock nested lifecycle calls (for example a turn that moves
        // its workspace). Existing operation-specific locks keep their order.
        await this.host().threadLifecycleLocks.run(key, async () => {});
      }
      const result = await work(finishMutation);
      finishMutation();
      await this.observeReleasedArchiveReference(backend, identity.threadId,
        typeof readRecord(result)?.archivedAt === "number" ? true : typeof readRecord(result)?.restoredAt === "number" ? false : undefined);
      return result;
    } finally {
      finishMutation();
    }
  }

  /** Computed on read: `hibernationKeepReason` asks only once every rule
   * the thread row decides has passed, and most candidates stop earlier.
   * `owners` indexes the same candidate list the caller holds. */
  private checkoutHibernationContext(candidate: ThreadArchiveCandidate, owners: CheckoutPathOwners): HibernationContext {
    const busy = () => {
      const runtime = candidate.overlay?.codexEnvironmentRuntime ?? candidate.thread.codexEnvironmentRuntime;
      return this.autoArchiveCandidateIsBusy(candidate)
        || runtime?.actionStatus === "started"
        || runtime?.actionRuns?.some((run) => run.status === "started") === true;
    };
    const sharedPath = () => {
      const target = hibernationTarget(candidate);
      return "keep" in target ? false : owners.sharedWithAnotherThread(candidate, target.worktreePath);
    };
    return {
      get busy() { return busy(); },
      get sharedPath() { return sharedPath(); },
    };
  }

  /** Removing an identified checkout cannot attach an unknown owner. Keep
   * the ordinary workspace writer fence without invalidating the fleet as
   * an unidentified directory move would. The queue owns overlapping paths. */
  private async withHibernatingCheckout<T>(owner: string, worktreePath: string, work: () => Promise<T>): Promise<T> {
    const finish = this.archiveWorkspaceOwnership.beginMutation(owner, true);
    try {
      await this.archiveWorkspaceOwnership.assertAvailable([worktreePath]);
      return await work();
    } finally {
      await this.archiveWorkspaceOwnership.refresh(finish(), async () => [worktreePath]);
    }
  }

  /**
   * Hibernates one idle thread's checkout: snapshot, re-check, remove, then
   * one SQLite commit for the snapshot record. Housekeeping order matches
   * automatic archive: the reservation (which any operator action on the
   * thread cancels), then its lifecycle lock, then the workspace write.
   * Resolves true when hibernated, false when cancelled, or a keep reason.
   */
  private async hibernateIdleCheckout(
    candidate: ThreadArchiveCandidate,
    policy: DesktopCheckoutHibernationPolicy,
    options: { reviewed?: boolean; context?: ArchiveCleanupContext; onStage?: (stage: ThreadMaintenanceRunStage) => void } = {},
  ): Promise<boolean | string> {
    const target = hibernationTarget(candidate);
    if ("keep" in target) return target.keep;
    const { source: backend, id: threadId } = candidate.thread;
    const key = buildThreadIdentityKey(backend, threadId);
    if (this.automaticArchiveReservations.has(key)) return false;
    const reservation = { cancelled: false, worktreePath: target.worktreePath };
    this.automaticArchiveReservations.set(key, reservation);
    const policyKey = JSON.stringify(policy);
    const paths = (item: ThreadArchiveCandidate) => JSON.stringify(
      [...item.thread.linkedDirectories, ...item.overlay?.extraLinkedDirectories ?? []]
        .map((directory) => directory.worktreePath ?? directory.path).sort());
    try {
      return await this.host().threadLifecycleLocks.run(key, async () => {
        if (reservation.cancelled) return false;
        let snapshot: WorktreeSnapshotSummary;
        // The last probe before removal. The tree check below proves the
        // snapshot holds exactly these files.
        let saved: Extract<Awaited<ReturnType<typeof inspectHibernationWorkspace>>, { keep?: undefined }> | undefined;
        try {
          const hibernate = () => this.withHibernatingCheckout(key, target.worktreePath, async () => await this.host().worktreeArchiveService.hibernate({
            backend, threadId,
            worktreePath: target.worktreePath,
            repositoryPath: target.repositoryPath,
            capSnapshotBytes: policy.maxSnapshotMb * 1024 * 1024,
            onStage: options.onStage,
            beforeRemove: async () => {
              options.onStage?.("checking");
              // Checks 1 to 5 again, against fresh thread state.
              const current = await this.refreshAutoArchiveCandidate(candidate, { deferOwnership: true });
              const inventory = options.context ? await options.context.withInventory!(async () =>
                await this.cleanupInventory.readPacedArchiveCleanupInventory({ backend, threadId, context: options.context, ownershipScope: target.worktreePath })) : undefined;
              // Membership is authoritative even when an archived provider
              // row has no archivedAt timestamp. Only active owners hold it.
              const all: Array<Pick<ThreadArchiveCandidate, "thread" | "finishedMonitorWorker" | "unreadable">> = inventory
                ? inventory.activeThreads.map((thread) => ({ thread }))
                : await this.readAutoArchiveCandidates(undefined, undefined, () => {
                    if (reservation.cancelled) throw new AutomaticArchiveCancelledError();
                  });
              // An unreadable overlay may hide an owner of any checkout.
              // The paced removal inventory has its own unknown-owner fence.
              if (!inventory && all.some((owner) => owner.unreadable)) {
                throw new CheckoutHibernationKeptError("Thread state unreadable");
              }
              if (inventory) await this.markFinishedMonitorWorkers(all);
              current.managedWorktreePath = await this.managedMaintenanceCheckout(current.thread,
                inventory ?? this.maintenanceOwnershipInventory(all, current));
              // Indexed from the list just read, never the pass that chose
              // this candidate: sharing is decided again here.
              const owners = new CheckoutPathOwners(all);
              const assertCurrent = () => {
                options.context?.assertCurrent();
                // A reviewed run uses the policy it was reviewed under, so a
                // change to Settings does not cancel it; the sweep's does.
                if (reservation.cancelled || this.context.lifecycle.closed
                  || (!options.reviewed && JSON.stringify(this.readCheckoutHibernationPolicy()) !== policyKey)) {
                  throw new AutomaticArchiveCancelledError();
                }
                const reason = hibernationKeepReason(current, Date.now(), policy, this.checkoutHibernationContext(current, owners));
                if (reason) throw new CheckoutHibernationKeptError(reason);
                if (checkoutHibernationLastActivity(current) > checkoutHibernationLastActivity(candidate)) {
                  throw new CheckoutHibernationKeptError(HIBERNATION_KEEP_REASONS.recentlyActive);
                }
                if (paths(current) !== paths(candidate)) throw new CheckoutHibernationKeptError("Workspace moved");
                // Never close an operator's terminal to hibernate.
                if (hasWorktreeTerminalsOpenIn(target.worktreePath)) throw new CheckoutHibernationKeptError("Terminal open");
              };
              assertCurrent();
              const workspace = await inspectHibernationWorkspace(target.worktreePath, {
                signal: new AbortController().signal,
                limitBytes: policy.maxSnapshotMb * 1024 * 1024,
                removeRebuildableOutput: policy.removeRebuildableOutput,
              });
              if (workspace.keep !== undefined) throw new CheckoutHibernationKeptError(workspace.keep);
              saved = workspace;
              assertCurrent();
              return assertCurrent;
            },
          }));
          snapshot = await this.host().withGoalHibernation({ backend, threadId }, hibernate);
        } catch (error) {
          if (error instanceof AutomaticArchiveCancelledError) return false;
          if (error instanceof CheckoutHibernationKeptError) return error.reason;
          if (error instanceof SnapshotTreeMismatchError) return "Changed while saving";
          if (error instanceof MissingArchiveWorktreeError) return HIBERNATION_WORKSPACE_KEEP_REASONS.missing;
          if (error instanceof MissingArchiveRepositoryError) return "Repository missing";
          if (error instanceof SnapshotLimitExceededError) {
            return HIBERNATION_WORKSPACE_KEEP_REASONS.overLimit;
          }
          throw error;
        }
        if (saved) {
          snapshot = { ...snapshot, changedFileCount: saved.files, changedBytes: saved.bytes,
            ...(saved.removedOutput ? { removedOutput: saved.removedOutput } : {}) };
        }
        // The one commit a hibernation makes. Recorded even if the operator
        // acted meanwhile: the checkout is gone and this is its only record.
        options.onStage?.("recording");
        await this.context.stores.archive.upsertWorktreeSnapshot({ backend, threadId, snapshot });
        this.checkoutRestoreFailures.delete(key);
        this.undeliveredCheckoutRestoreFailures.delete(key);
        backendRegistryLog.info("idle checkout hibernated", {
          backend, threadId, worktreePath: snapshot.worktreePath, snapshotRef: snapshot.snapshotRef,
        });
        await this.publishCheckoutHibernation({ backend, threadId }, {
          workspace: describeHibernatedThreadWorkspace({ linkedDirectories: [target.directory], worktreeSnapshots: [snapshot],
            codexEnvironmentRuntime: candidate.overlay?.codexEnvironmentRuntime ?? candidate.thread.codexEnvironmentRuntime }) ?? null,
        });
        this.host().invalidateThreadListCache(backend, true, threadId);
        this.host().threadInfoStore.invalidateSummaries({ backend, threadId });
        await this.host().publishLocalEvent({ backend, notification: {
          method: "navigation/threadDirectories/updated",
          params: { reason: "selected-thread", threadIds: [threadId] },
        } });
        return true;
      });
    } finally {
      if (this.automaticArchiveReservations.get(key) === reservation) this.automaticArchiveReservations.delete(key);
    }
  }

  /** Tells every surface what the thread card should show now: its
   * checkout (null once awake), Keep it awake, or both. */
  private async publishCheckoutHibernation(
    identity: { backend: AppServerBackendKind; threadId: string },
    change: {
      workspace?: ThreadHibernatedWorkspace | null;
      keepAwake?: boolean;
      restoredDetached?: { worktreePath: string; detachedFrom: NonNullable<WorktreeSnapshotSummary["detachedFrom"]> };
    },
  ): Promise<void> {
    await this.context.emit({ backend: identity.backend, notification: {
      method: "thread/checkoutHibernation/updated",
      params: { threadId: identity.threadId, ...change },
    } });
  }

  /** Ends a restore that did not finish: the card goes back to the
   * hibernated checkout it still is. */
  private async endUnfinishedCheckoutRestore(identity: { backend: AppServerBackendKind; threadId: string }): Promise<void> {
    const key = buildThreadIdentityKey(identity.backend, identity.threadId);
    const progress = this.checkoutRestoreProgress.get(key);
    if (!progress) return;
    this.checkoutRestoreProgress.delete(key);
    const { restoring: _restoring, restorePhase: _phase, ...hibernated } = progress;
    await this.publishCheckoutHibernation(identity, { workspace: hibernated });
  }

  /** The detail read's view of a hibernated checkout, or undefined. A failed
   * restore shows the missing-worktree card instead. */
  readCheckoutHibernation(identity: { backend: AppServerBackendKind; threadId: string }): {
    restoring: boolean;
    /** The running restore, while it lasts: kept after the snapshot record
     * reads restored, so the card stays through project setup. */
    progress?: ThreadHibernatedWorkspace;
    restoreFailure?: { worktreePath: string; message: string };
  } {
    const key = buildThreadIdentityKey(identity.backend, identity.threadId);
    const progress = this.checkoutRestoreProgress.get(key);
    return {
      restoring: this.checkoutRestores.has(key),
      ...(progress ? { progress } : {}),
      ...(this.checkoutRestoreFailures.has(key) ? { restoreFailure: this.checkoutRestoreFailures.get(key) } : {}),
    };
  }

  private async activeHibernatedSnapshot(
    identity: { backend: AppServerBackendKind; threadId: string },
    overlay: ThreadOverlayState | undefined,
  ): Promise<WorktreeSnapshotSummary | undefined> {
    const snapshots = overlay?.worktreeSnapshots;
    if (!overlay || !snapshots?.some((snapshot) => snapshot.state === "hibernated")) return undefined;

    // A handoff link is durable across provider synchronization and restarts.
    // Snapshots of the former workspace remain available as checkpoints.
    const directories = overlay.extraLinkedDirectories;
    const thread = this.host().getCachedThreadSummary(identity);
    const hasHandoff = directories.some(isHandoffDirectory) || thread?.linkedDirectories.some(isHandoffDirectory);
    const cwd = thread || hasHandoff
      ? resolveThreadWorkspaceCwd(thread, directories)
      : await this.host().resolveThreadEnvironmentCwd(identity.backend, identity.threadId, overlay);
    if (!cwd) return undefined;
    const hibernated = snapshots.filter((snapshot) => snapshot.state === "hibernated");
    const resolvedCwd = path.resolve(cwd);
    const exact = hibernated.find((snapshot) => path.resolve(snapshot.worktreePath) === resolvedCwd);
    if (exact) return exact;

    // Git cannot resolve a deleted checkout. Canonicalize through the
    // surviving parents, then look for the nearest missing checkout root.
    // A committed handoff already identifies its root, even if it is missing.
    const canonical = canonicalWorktreePaths();
    const workspacePath = await canonical(cwd).catch(() => undefined);
    if (!workspacePath) return undefined;
    const byPath = new Map<string, WorktreeSnapshotSummary>();
    for (const snapshot of hibernated) {
      const root = await canonical(snapshot.worktreePath).catch(() => undefined);
      if (root) byPath.set(root, snapshot);
    }
    const canonicalMatch = byPath.get(workspacePath);
    if (canonicalMatch || hasHandoff) return canonicalMatch;
    for (let parent = path.dirname(workspacePath); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      const snapshot = byPath.get(parent);
      if (snapshot) return await pathExists(parent).catch(() => true) ? undefined : snapshot;
    }
    return undefined;
  }

  /**
   * Starts restoring a hibernated checkout without waiting for it, so a send
   * made now queues behind the restore and starts when it ends. Resolves
   * whether a restore is running.
   */
  async wakeHibernatedCheckout(identity: { backend: AppServerBackendKind; threadId: string }, retryFailed = true): Promise<boolean> {
    const key = buildThreadIdentityKey(identity.backend, identity.threadId);
    if (this.checkoutRestores.has(key)) return true;
    const overlay = await this.context.stores.threads.getThreadOverlayState(identity);
    const snapshot = await this.activeHibernatedSnapshot(identity, overlay);
    if (!snapshot) return false;
    // Opening the thread does not retry a failure for this checkout.
    if (!retryFailed && this.checkoutRestoreFailures.get(key)?.worktreePath === snapshot.worktreePath) return false;
    // A fresh request: the operator asked again, so a failure is retried.
    this.undeliveredCheckoutRestoreFailures.delete(key);
    void this.restoreHibernatedCheckout(identity).catch(() => {});
    return this.checkoutRestores.has(key);
  }

  /**
   * Restore now, Keep it awake, and the thread menu's toggle. Keeping a
   * thread awake also restores a hibernated checkout. The exemption is one
   * commit when it changes; the restore costs what a send's restore does.
   */
  async setThreadCheckoutHibernation(request: {
    backend: AppServerBackendKind;
    threadId: string;
    restore?: boolean;
    keepAwake?: boolean;
  }): Promise<SetThreadCheckoutHibernationResponse> {
    const identity = { backend: request.backend, threadId: request.threadId };
    const key = buildThreadIdentityKey(identity.backend, identity.threadId);
    let overlay = await this.context.stores.threads.getThreadOverlayState(identity);
    let keepAwake = overlay?.keepCheckoutAwake === true;
    if (request.keepAwake !== undefined && request.keepAwake !== keepAwake) {
      overlay = await this.context.stores.archive.setThreadKeepCheckoutAwake({ ...identity, keepAwake: request.keepAwake });
      keepAwake = request.keepAwake;
      this.host().invalidateThreadListCache(identity.backend, true, identity.threadId);
      await this.publishCheckoutHibernation(identity, { keepAwake });
    }
    let hibernated = Boolean(await this.activeHibernatedSnapshot(identity, overlay));
    let restoreError: string | undefined;
    if ((request.restore === true || request.keepAwake === true) && hibernated) {
      // The operator asked: a failure recorded earlier is retried.
      this.undeliveredCheckoutRestoreFailures.delete(key);
      try {
        await this.restoreHibernatedCheckout(identity);
      } catch (error) {
        restoreError = error instanceof Error ? error.message : String(error);
      }
      const current = await this.context.stores.threads.getThreadOverlayState(identity);
      hibernated = Boolean(await this.activeHibernatedSnapshot(identity, current));
    }
    return {
      backend: identity.backend,
      threadId: identity.threadId,
      keepAwake,
      hibernated,
      ...(restoreError ? { restoreError } : {}),
    };
  }

  /** Restore on open, when the policy says so. */
  async wakeHibernatedCheckoutOnOpen(identity: { backend: AppServerBackendKind; threadId: string }): Promise<boolean> {
    if (this.readCheckoutHibernationPolicy().restoreOn !== "open") return false;
    return await this.wakeHibernatedCheckout(identity, false);
  }

  /**
   * Every turn start passes here. A hibernated checkout is put back first;
   * concurrent callers share that restore. A failure the queue has not yet
   * reported is reported once, without another attempt, so a held message
   * carries the reason until the operator retries it.
   */
  async ensureCheckoutAwake(identity: { backend: AppServerBackendKind; threadId: string }): Promise<void> {
    const key = buildThreadIdentityKey(identity.backend, identity.threadId);
    const running = this.checkoutRestores.get(key);
    if (running) {
      await running;
      return;
    }
    const overlay = await this.context.stores.threads.getThreadOverlayState(identity);
    const snapshot = await this.activeHibernatedSnapshot(identity, overlay);
    if (!snapshot) return;
    const failure = this.checkoutRestoreFailures.get(key);
    if (failure?.worktreePath === snapshot.worktreePath && this.undeliveredCheckoutRestoreFailures.delete(key)) {
      throw new Error(failure.message);
    }
    await this.restoreHibernatedCheckout(identity);
  }

  /** Hold turn admission while another thread is putting the same checkout back. */
  withCheckoutRecovery<T>(worktreePath: string, work: () => Promise<T>): Promise<T> {
    return this.checkoutRecoveryLocks.run(path.resolve(worktreePath), work);
  }

  private restoreHibernatedCheckout(identity: { backend: AppServerBackendKind; threadId: string }, snapshotId?: string): Promise<void> {
    const key = buildThreadIdentityKey(identity.backend, identity.threadId);
    const existing = this.checkoutRestores.get(key);
    if (existing) {
      // Explicit requests may name different checkpoints. Recheck the named
      // snapshot after the in-flight restore settles.
      return snapshotId === undefined ? existing
        : existing.catch(() => {}).then(() => this.restoreHibernatedCheckout(identity, snapshotId));
    }
    const restore = this.withThreadLifecycleMutation(identity, async () => await this.restoreHibernatedCheckoutNow(identity, snapshotId))
      .finally(async () => {
        // A restore that threw before it finished still ends on every surface.
        await this.endUnfinishedCheckoutRestore(identity).catch(() => {});
        this.checkoutRestores.delete(key);
        // A message that queued behind the restore starts now, or is held
        // with the restore's refusal.
        this.host().threadTurnQueue.scheduleThreadDrain(identity);
      });
    this.checkoutRestores.set(key, restore);
    return restore;
  }

  /** At most two commits: the snapshot record, and the environment runtime
   * when setup ran. A refusal writes nothing. */
  private async restoreHibernatedCheckoutNow(identity: { backend: AppServerBackendKind; threadId: string }, snapshotId?: string): Promise<void> {
    const overlay = await this.context.stores.threads.getThreadOverlayState(identity);
    const snapshot = snapshotId === undefined
      ? await this.activeHibernatedSnapshot(identity, overlay)
      : overlay?.worktreeSnapshots?.find((candidate) => candidate.id === snapshotId && candidate.state === "hibernated");
    if (!snapshot) return;
    let setupRuntime = overlay?.codexEnvironmentRuntime;
    if (snapshotId !== undefined && setupRuntime && (await this.activeHibernatedSnapshot(identity, overlay))?.id !== snapshotId) {
      setupRuntime = undefined;
    }
    await this.withCheckoutRecovery(snapshot.worktreePath,
      () => this.restoreHibernatedSnapshot(identity, snapshot, setupRuntime, snapshotId === undefined));
  }

  private async restoreHibernatedSnapshot(
    identity: { backend: AppServerBackendKind; threadId: string },
    snapshot: WorktreeSnapshotSummary,
    setupRuntime: CodexThreadEnvironmentRuntime | undefined,
    restoringCurrentCheckout: boolean,
  ): Promise<void> {
    const key = buildThreadIdentityKey(identity.backend, identity.threadId);
    const progress: ThreadHibernatedWorkspace = {
      ...describeHibernatedThreadWorkspace({ linkedDirectories: [{ id: "restore", kind: "worktree", label: "",
        path: snapshot.repositoryPath, worktreePath: snapshot.worktreePath }], worktreeSnapshots: [snapshot],
        codexEnvironmentRuntime: setupRuntime })!,
      restoring: true,
      restorePhase: "checkout",
    };
    this.checkoutRestoreProgress.set(key, progress);
    await this.publishCheckoutHibernation(identity, { workspace: progress });
    const fail = async (message: string): Promise<never> => {
      this.checkoutRestoreFailures.set(key, { worktreePath: snapshot.worktreePath, message });
      this.undeliveredCheckoutRestoreFailures.add(key);
      backendRegistryLog.warn("hibernated checkout restore failed", { ...identity, worktreePath: snapshot.worktreePath, error: message });
      // Still hibernated until the next detail read, where the
      // missing-worktree card takes over with the refusal.
      await this.endUnfinishedCheckoutRestore(identity);
      await this.host().publishLocalEvent({ backend: identity.backend, notification: {
        method: "navigation/threadDirectories/updated",
        params: { reason: "selected-thread", threadIds: [identity.threadId] },
      } });
      throw new Error(message);
    };
    const recreate = async (detachedAt?: string, fallbackMissingSources = false) => await this.withArchiveWorkspaceWrite([snapshot.worktreePath], async () =>
      await this.host().worktreeRecoveryService.recreate({
        ...identity,
        repositoryPath: snapshot.repositoryPath,
        worktreePath: snapshot.worktreePath,
        checkpoint: { snapshotRef: snapshot.snapshotRef, snapshotCommit: snapshot.snapshotCommit, sourceHead: snapshot.sourceHead },
        ...(fallbackMissingSources ? { fallbackMissingSources: true } : {}),
        ...(detachedAt
          ? { detached: true, startPoint: detachedAt }
          : { branch: snapshot.sourceBranch, detached: !snapshot.sourceBranch, expectedHead: snapshot.sourceHead }),
      }));
    let result = await recreate();
    const missingSources = identity.backend === "codex" && restoringCurrentCheckout && result.status === "failed"
      && (result.reason === "checkpoint-missing" || result.reason === "branch-missing" && !snapshot.sourceHead);
    if (missingSources) result = await recreate(undefined, true);
    // Recovery leaves no checkout behind when the branch is checked out
    // elsewhere, moved, or gone. Retry at the saved HEAD, detached.
    const conflict = result.status === "failed" ? DETACHED_RESTORE_REASONS[result.reason] : undefined;
    let detachedFrom: WorktreeSnapshotSummary["detachedFrom"];
    if (result.status === "failed" && conflict && snapshot.sourceBranch && snapshot.sourceHead) {
      if (!missingSources) {
        detachedFrom = { branch: snapshot.sourceBranch, head: snapshot.sourceHead, reason: conflict,
          ...(result.branchCheckedOutAt ? { checkedOutAt: result.branchCheckedOutAt } : {}) };
      }
      result = await recreate(snapshot.sourceHead, missingSources);
    }
    if (result.status === "failed") return await fail(result.message);
    if (result.checkpoint && !result.checkpoint.restored) {
      // The checkout came back without its changes. Remove it again so the
      // snapshot stays the only copy and the next attempt starts clean.
      await removeManagedWorktree({
        worktreePath: snapshot.worktreePath,
        force: true,
        git: async (args) => (await runGitCommand(snapshot.repositoryPath, args)).stdout,
      }).catch(() => {});
      return await fail("The saved changes did not apply to the restored checkout. They are kept in its snapshot.");
    }
    const restoredAt = Date.now();
    await this.context.stores.archive.upsertWorktreeSnapshot({ ...identity, snapshot: { ...snapshot, state: "restored", restoredAt, detachedFrom } });
    this.checkoutRestoreFailures.delete(key);
    this.undeliveredCheckoutRestoreFailures.delete(key);
    backendRegistryLog.info("hibernated checkout restored", { ...identity, worktreePath: snapshot.worktreePath,
      ...(detachedFrom ? { detachedFrom: detachedFrom.reason } : {}) });
    await this.rerunEnvironmentSetupAfterRestore(identity, setupRuntime, snapshot.worktreePath, async () => {
      const setup = { ...progress, restorePhase: "setup" as const };
      this.checkoutRestoreProgress.set(key, setup);
      await this.publishCheckoutHibernation(identity, { workspace: setup });
    });
    this.checkoutRestoreProgress.delete(key);
    await this.publishCheckoutHibernation(identity, { workspace: null,
      ...(detachedFrom ? { restoredDetached: { worktreePath: snapshot.worktreePath, detachedFrom } } : {}) });
    this.host().invalidateThreadListCache(identity.backend, true, identity.threadId);
    this.host().threadInfoStore.invalidateSummaries(identity);
    await this.host().publishLocalEvent({ backend: identity.backend, notification: {
      method: "navigation/threadDirectories/updated",
      params: { reason: "selected-thread", threadIds: [identity.threadId] },
    } });
    if (missingSources && result.warnings.length) {
      await this.context.emit({ backend: identity.backend, notification: {
        method: "warning", params: { threadId: identity.threadId, message: result.warnings.join(" ") },
      } }).catch(() => {});
    }
  }

  /** A restored checkout has no rebuildable output, so a project
   * environment with a setup script runs it again. A setup failure is
   * recorded on the runtime; the checkout and the send go ahead. */
  private async rerunEnvironmentSetupAfterRestore(
    identity: { backend: AppServerBackendKind; threadId: string },
    sourceRuntime: CodexThreadEnvironmentRuntime | undefined,
    cwd: string,
    onSetupStart?: () => Promise<void>,
  ): Promise<void> {
    if (!sourceRuntime?.environmentId || sourceRuntime.executionTarget !== "local") return;
    const environment = (await listCodexEnvironmentOptions(cwd).catch(() => []))
      .find((candidate) => candidate.id === sourceRuntime.environmentId);
    if (!environment?.setupScript) return;
    await onSetupStart?.();
    let runtime: CodexThreadEnvironmentRuntime | undefined;
    try {
      runtime = await this.host().buildForkedCodexEnvironmentRuntime({ cwd, forceSetup: true, owner: identity, sourceRuntime, workMode: "worktree" });
    } catch (error) {
      if (!(error instanceof CodexEnvironmentStartupError)) throw error;
      runtime = error.runtime;
      backendRegistryLog.warn("environment setup failed after checkout restore", { ...identity, error: error.message });
    }
    if (runtime) await this.context.stores.workspaces.setThreadCodexEnvironmentRuntime?.({ ...identity, codexEnvironmentRuntime: runtime });
  }

  private async refreshAutoArchiveCandidate(candidate: ThreadArchiveCandidate, options: { deferOwnership?: boolean } = {}): Promise<ThreadArchiveCandidate> {
    const { source: backend, id: threadId } = candidate.thread;
    const thread = isAcpBackendId(backend)
      ? (() => {
          const session = this.context.providers.acp.getSession(backend, threadId);
          return session ? this.context.providers.acp.sessionToThreadSummary(session) : undefined;
        })()
      : backend === "claude"
        ? await this.context.providers.claude.readThreadSummary(threadId)
        : await this.host().withCodexThreadClient(threadId, async (client) => {
            if (!client.readThreadSummary) throw new Error("Thread metadata reads are unavailable.");
            return await client.readThreadSummary(threadId);
          });
    if (!thread) throw new Error(`Thread metadata was not found: ${threadId}`);
    const overlay = await this.context.stores.threads.getThreadOverlayState({ backend, threadId });
    const resolved = await this.maintenanceThreadWorkspace(thread, overlay);
    const watches = await this.maintenancePrWatches(await this.context.stores.pullRequests.listActiveThreadPrStatusWatches({ backend, threadId }), overlay);
    const refreshed: ThreadArchiveCandidate = {
      thread: {
        ...candidate.thread,
        ...resolved,
      },
      overlay,
      managedWorktreePath: await this.managedMaintenanceCheckout(resolved),
      activeSubAgent: await this.hasArchiveActiveSubAgent(backend, threadId),
      activePrWatch: watches.length > 0,
      activePrWatches: watches,
      mergeHeld: this.readMergeHeldThreadKeys().has(buildThreadIdentityKey(backend, threadId)),
    };
    if (!options.deferOwnership && !refreshed.managedWorktreePath && primaryThreadWorktree(resolved)?.worktreeOwnership === "external") {
      const all = await this.readAutoArchiveCandidates();
      refreshed.managedWorktreePath = await this.managedMaintenanceCheckout(resolved, this.maintenanceOwnershipInventory(all, refreshed));
    }
    return refreshed;
  }

  /** One partial-index read; finished cards, including every gate card, are not scanned. */
  private async hasArchiveActiveSubAgent(backend: AppServerBackendKind, threadId: string): Promise<boolean> {
    const active = await this.context.stores.subAgents.listActiveThreadSubAgents({ backend, threadId });
    return active.some((agent) => ARCHIVE_ACTIVE_SUB_AGENT_STATUSES.includes(agent.status));
  }

  private autoArchiveCandidateIsBusy(candidate: ThreadArchiveCandidate): boolean {
    const { thread } = candidate;
    const identity = { backend: thread.source, threadId: thread.id };
    const info = this.host().threadInfoStore.get(identity);
    return this.context.lifecycle.closed || this.host().stoppingRunningTurnsForShutdown
      || this.threadLifecycleMutationCounts.has(buildThreadIdentityKey(thread.source, thread.id))
      || this.host().threadHandoffReservations.has(buildThreadIdentityKey(thread.source, thread.id))
      || this.host().threadStarts.hasPending(identity)
      || (thread.source === "codex" && this.host().codexBackgroundTerminals.has(thread.id))
      || (thread.source === "claude" && this.context.providers.claude.hasLiveSession(thread.id))
      || this.host().threadHasActiveTurn(thread.id, thread.source)
      || this.host().threadHasBlockingWorkspaceMove(identity)
      || this.host().threadTurnQueue.getQueuedEntries(identity).length > 0
      || (info?.archived === true && !isArchivedCheckoutCandidate(candidate))
      || (thread.archivedAt === undefined && (info?.updatedAt ?? 0) > (thread.updatedAt ?? 0))
      || [...this.host().pendingServerRequests.values()].some((pending) =>
        pending.backend === thread.source && pending.notification.params.threadId === thread.id,
      );
  }

  /** Observe provider archives, then publish the changes only after their transaction commits. */
  async observeArchivedThreads(
    records: Array<{ backend: AppServerBackendKind; threadId: string }>,
    now: number,
    options?: { promoteSubthreads: boolean },
  ): Promise<void> {
    const retired = await this.context.stores.archive.observeArchivedThreads?.(records, now, options);
    await this.publishArchivedThreadAutomationRetirements(retired ?? []);
  }

  async publishArchivedThreadAutomationRetirements(retired: ArchivedThreadAutomationRetirement[]): Promise<void> {
    for (const thread of retired) {
      const identity = { backend: thread.backend, threadId: thread.threadId };
      if (thread.prWatchesChanged || thread.autoFixChanged) {
        await this.context.emit({ backend: thread.backend, notification: {
          method: "thread/prWatches/updated", params: identity,
        } });
      }
      if (thread.autoFixChanged) {
        await this.context.emit({ backend: thread.backend, notification: {
          method: "thread/prAutoDispatch/updated", params: { threadId: thread.threadId, enabled: false },
        } });
        await this.context.emit({ backend: thread.backend, notification: {
          method: "thread/prAutoDispatch/pendingUpdated", params: { threadId: thread.threadId, pending: null },
        } });
      }
      for (const dependency of thread.dependencies) {
        const targets = new Map([identity, ...dependency.conditions].map((target) => [
          buildThreadIdentityKey(target.backend, target.threadId), target,
        ]));
        for (const target of targets.values()) await this.context.emit({ backend: target.backend, notification: {
          method: "thread/dependencies/updated", params: { threadId: target.threadId, dependencyId: dependency.id },
        } });
      }
    }
  }

  async archiveThread(
    request: ArchiveThreadRequest & { preserveWorktrees?: boolean },
  ): Promise<ArchiveThreadResponse> {
    const requestedAt = Date.now();
    const logFields = { backend: request.backend ?? "codex", threadId: request.threadId, runtimeInstanceId: this.host().runtimeInstanceId, requestedAt };
    backendRegistryLog.info("thread archive requested", { ...logFields, backgroundCleanup: request.backgroundCleanup === true });
    const key = buildThreadIdentityKey(request.backend ?? "codex", request.threadId);
    if (this.archiveCleanupQueue.isCancelled(key)) {
      // Archive after an intervening restore is a new mutation, not a
      // duplicate of the cancelled cleanup from the previous archive.
      const previous = this.threadArchiveOperations.get(key);
      await this.cancelAndWaitArchiveCleanups(key);
      await previous?.catch(() => {});
    }
    const queued = this.archiveCleanupCompletions.get(key);
    if (queued && request.backgroundCleanup) {
      return { backend: request.backend ?? "codex", threadId: request.threadId, archivedAt: queued.archivedAt, cleanup: [], cleanupPending: true };
    }
    const pending = this.threadArchiveOperations.get(key) ?? queued?.promise;
    if (pending) return await pending;
    const operation = this.withThreadLifecycleMutation(request, async (finishMutation) =>
      await this.archiveThreadWithoutLifecycleLock(request, undefined, finishMutation),
      true,
    );
    this.threadArchiveOperations.set(key, operation);
    try {
      const result = await operation;
      this.host().pendingEnvironmentLaunchStore.delete({ backend: request.backend ?? "codex", threadId: request.threadId });
      return result;
    }
    catch (error) {
      backendRegistryLog.warn("thread archive failed", { ...logFields, durationMs: Date.now() - requestedAt, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    finally { if (this.threadArchiveOperations.get(key) === operation) this.threadArchiveOperations.delete(key); }
  }

  private async archiveThreadWithoutLifecycleLock(
    request: ArchiveThreadRequest & { preserveWorktrees?: boolean },
    beforeMutation?: () => Promise<() => void>,
    finishMutation?: (archived?: true) => void,
  ): Promise<ArchiveThreadResponse> {
    const backend = request.backend ?? "codex";
    if (request.expectedParent !== undefined) {
      const overlay = await this.context.stores.threads?.getThreadOverlayState({ backend, threadId: request.threadId });
      const expected = request.expectedParent;
      if (expected === null ? Boolean(overlay?.parentThreadId)
        : overlay?.parentThreadId !== expected.threadId
          || (overlay.parentThreadBackend ?? backend) !== expected.backend
          || overlay.parentThreadInstanceId !== expected.instanceId) {
        throw new Error("Thread grouping changed before archive. Refresh the group and try again.");
      }
    }
    if (backend === "claude") {
      const admit = await beforeMutation?.();
      admit?.();
      await this.context.providers.claude.setArchived(request.threadId, true);
      const archivedAt = Date.now();
      backendRegistryLog.info("thread archive mutation completed", {
        backend, threadId: request.threadId, runtimeInstanceId: this.host().runtimeInstanceId, archivedAt,
      });
      // Same bookkeeping as ACP: preserve the tray and record the archive
      // before publishing its removal. Cleanup snapshots the checkout afterward.
      await this.observeArchivedThreads([{ backend, threadId: request.threadId }], archivedAt, { promoteSubthreads: true });
      this.host().pendingStartedThreads.delete(buildThreadIdentityKey(backend, request.threadId));
      this.host().invalidateThreadListCache(backend);
      this.invalidateArchiveCleanupReads(backend, undefined, true, request.threadId, [], "archived");
      await this.context.emit({ backend, notification: { method: "thread/archived", params: { threadId: request.threadId } } });
      const messagingCleanup = await this.cleanupMessagingForArchivedThread({
        backend,
        threadId: request.threadId,
        origin: "thread-archive",
      });
      const completion = this.enqueueArchiveCleanup({ backend, threadId: request.threadId, archivedAt, codexRolloutMissing: false,
        preserveWorktrees: request.preserveWorktrees, messagingCleanup });
      finishMutation?.(true);
      return await this.observeArchiveCleanupCompletion(completion, {
        backend, threadId: request.threadId, archivedAt, backgroundCleanup: request.backgroundCleanup,
      });
    }
    if (isAcpBackendId(backend)) {
      return await this.archiveAcpThread({
        backend,
        threadId: request.threadId, backgroundCleanup: request.backgroundCleanup, preserveWorktrees: request.preserveWorktrees,
      }, beforeMutation, finishMutation);
    }
    let result: { threadId: string };
    let archivedAt: number;
    let codexRolloutMissing = false;
    try {
      result = await this.host().withCodexThreadClient(request.threadId, async (client) => {
        // Cleanup discovery and client routing both await reads. Admission
        // belongs here, immediately before the provider mutation.
        const assertAdmission = await beforeMutation?.();
        assertAdmission?.();
        return await this.archiveWithClient(client, request.threadId);
      });
      archivedAt = Date.now();
    } catch (error) {
      if (
        backend !== "codex"
        || !isCodexMissingRolloutArchiveError(error, request.threadId)
      ) {
        throw error;
      }

      archivedAt = Date.now();
      codexRolloutMissing = true;
      backendRegistryLog.warn("codex archive continuing cleanup for missing rollout", {
        backend,
        threadId: request.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      result = { threadId: request.threadId };
    }
    backendRegistryLog.info("thread archive mutation completed", {
      backend, threadId: result.threadId, runtimeInstanceId: this.host().runtimeInstanceId, archivedAt, codexRolloutMissing,
    });
    // A successful archive supersedes the provisional active workspace kept
    // until navigation acknowledges a newly started or forked thread. Leaving
    // it pending makes cleanup rediscover the archived target as active.
    // Missing-rollout recovery still needs any retained workspace until its
    // cleanup and tombstone have settled.
    if (!codexRolloutMissing) this.host().pendingStartedThreads.delete(buildThreadIdentityKey(backend, result.threadId));
    await this.observeArchivedThreads([{ backend, threadId: result.threadId }], archivedAt, { promoteSubthreads: true });
    this.host().invalidateThreadListCache(backend);
    this.invalidateArchiveCleanupReads(backend, undefined, true, result.threadId, [], "archived");
    if (backend === "codex") await this.archiveTokenMiserThread(result.threadId);
    const messagingCleanup = await this.cleanupMessagingForArchivedThread({
      backend,
      threadId: result.threadId,
      origin: "thread-archive",
    });
    const completion = this.enqueueArchiveCleanup({
      backend, threadId: result.threadId, archivedAt, codexRolloutMissing,
      preserveWorktrees: request.preserveWorktrees, messagingCleanup,
    });
    // The provider mutation and critical archive bookkeeping have settled.
    // Synchronous callers now wait only for the serial cleanup queue; keeping
    // them in mutation admission would prevent independent queued removals.
    // The operation promise remains registered for inverse-intent ordering.
    finishMutation?.(codexRolloutMissing ? undefined : true);
    await this.observeReleasedArchiveReference(backend, result.threadId, true);
    return await this.observeArchiveCleanupCompletion(completion, {
      backend, threadId: result.threadId, archivedAt, backgroundCleanup: request.backgroundCleanup, mustComplete: codexRolloutMissing,
    });
  }

  getArchiveCleanupCountForQuit(): number {
    return new Set([...this.pendingArchiveCleanupIntents.keys(), ...this.archiveCleanupQueue.pendingKeys(), ...this.archiveCleanupOverflow.keys()]).size;
  }

  checkpointArchiveCleanupsForQuit(): void {
    const intents = new Map(this.archiveCleanupRetryIntents);
    for (const intent of this.archiveWorktreeReferences.intents()) intents.set(buildThreadIdentityKey(intent.backend, intent.threadId), intent);
    for (const [key, intent] of this.pendingArchiveCleanupIntents) {
      const deferred = intents.get(key)?.deferredWorktrees;
      intents.set(key, intent.deferredWorktrees && deferred ? { ...intent, deferredWorktrees: deferred } : intent);
    }
    this.archiveCleanupCheckpointStore?.save(this.host().runtimeInstanceId, [...intents.values()]);
  }

  tryCheckpointArchiveCleanupsForQuit(phase: "before-drain" | "after-drain" | "reference-change" | "recovery-drain"): void {
    // A release or removal only shrinks the backlog, and recovery rereads every
    // recovered row, so a reference boundary persists only what was added.
    // Rewriting the remaining backlog after each release was quadratic.
    // A drained backlog is still written: an empty checkpoint serializes nothing.
    const additions = this.archiveWorktreeReferences.additions + this.archiveCleanupIntentAdditions;
    if (phase === "reference-change" && additions === this.archiveCheckpointedAdditions && this.archiveCheckpointedAdditions >= 0
      && (this.archiveWorktreeReferences.hasOwners || this.pendingArchiveCleanupIntents.size > 0)) return;
    try {
      this.checkpointArchiveCleanupsForQuit();
      this.archiveCheckpointedAdditions = additions;
    } catch (error) {
      // Persistence failure must not prevent queue cancellation or backend
      // disposal, nor poison the memoized shutdown operation.
      backendRegistryLog.error("archive cleanup quit checkpoint failed", {
        phase, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private cancelArchiveCleanups(key: string): void {
    const scheduled = this.pendingArchiveCleanupIntents.get(key) ?? this.archiveCleanupRetryIntents.get(key);
    this.archiveCleanupRetryIntents.delete(key);
    this.archiveWorktreeReferences.forgetOwner(key, scheduled?.deferredWorktrees);
    this.cancelArchiveCleanupOverflow(key);
    this.archiveCleanupQueue.cancel(key);
    for (const [job, owner] of this.archiveRepairOwners) if (owner === key) this.archiveCleanupQueue.cancel(job);
    if (scheduled?.deferredWorktrees?.length) this.dispatchReleasedArchiveCleanups(this.archiveWorktreeReferences.readyIntents());
  }

  private async cancelAndWaitArchiveCleanups(key: string): Promise<void> {
    this.cancelArchiveCleanupOverflow(key);
    await Promise.all([key, ...[...this.archiveRepairOwners].filter(([, owner]) => owner === key).map(([job]) => job)]
      .map(async (job) => { await this.archiveCleanupQueue.cancelAndWait(job); }));
    this.archiveCleanupRetryIntents.delete(key);
  }

  private drainArchiveCleanupOverflow(): void {
    for (const [key, waiting] of this.archiveCleanupOverflow) {
      if (this.context.lifecycle.closed || this.archiveCleanupQueue.availableSlots <= 0) return;
      this.archiveCleanupOverflow.delete(key);
      this.enqueueArchiveCleanup(waiting.intent, waiting.resuming).then(waiting.resolve, waiting.reject);
    }
  }

  cancelArchiveCleanupOverflow(key: string): void {
    const waiting = this.archiveCleanupOverflow.get(key);
    if (!waiting) return;
    this.archiveCleanupOverflow.delete(key);
    waiting.reject(new ArchiveCleanupCancelledError());
  }

  private enqueueArchiveRepair(owner: string, worktreePath: string, work: (context: ArchiveCleanupContext) => Promise<ArchiveThreadResponse>): Promise<ArchiveThreadResponse> {
    const key = `archive-repair:${worktreePath}`;
    if (!this.archiveRepairOwners.has(key)) this.archiveRepairOwners.set(key, owner);
    return this.archiveCleanupQueue.enqueue(key, work).finally(() => this.archiveRepairOwners.delete(key));
  }

  private enqueueArchiveCleanup(intent: ArchiveCleanupIntent, resuming = false): Promise<ArchiveThreadResponse> {
    const key = buildThreadIdentityKey(intent.backend, intent.threadId);
    const existing = this.archiveCleanupQueue.pending(key) ?? this.archiveCleanupOverflow.get(key)?.promise;
    if (existing) return existing;
    this.archiveCleanupRetryIntents.delete(key);
    if (!this.context.lifecycle.closed && this.archiveCleanupQueue.availableSlots <= 0) {
      // A bulk archive can outrun the physical queue. Hold the intent rather
      // than refuse its cleanup; a freed slot admits it in arrival order.
      let resolve!: (response: ArchiveThreadResponse) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<ArchiveThreadResponse>((accept, fail) => { resolve = accept; reject = fail; });
      this.pendingArchiveCleanupIntents.set(key, intent);
      this.archiveCleanupOverflow.set(key, { intent, resuming, resolve, reject, promise });
      backendRegistryLog.info("archive cleanup waiting for queue capacity", {
        backend: intent.backend, threadId: intent.threadId, runtimeInstanceId: this.host().runtimeInstanceId, waiting: this.archiveCleanupOverflow.size,
      });
      void promise.catch((error: unknown) => {
        if (!(this.context.lifecycle.closed && error instanceof ArchiveCleanupCancelledError)
          && this.pendingArchiveCleanupIntents.get(key) === intent) this.pendingArchiveCleanupIntents.delete(key);
      });
      return promise;
    }
    const queuedAt = Date.now();
    const logFields = { backend: intent.backend, threadId: intent.threadId, archivedAt: intent.archivedAt, runtimeInstanceId: this.host().runtimeInstanceId, queuedAt };
    backendRegistryLog.info("archive cleanup queued", { ...logFields, resuming, queueDepth: this.archiveCleanupQueue.pendingKeys().length + 1 });
    // Released and recovered intents are already durable; a fresh archive is not.
    if (!resuming && this.pendingArchiveCleanupIntents.get(key) !== intent) this.archiveCleanupIntentAdditions += 1;
    this.pendingArchiveCleanupIntents.set(key, intent);
    let startedAt: number | undefined;
    let metadataUnavailable = false;
    const completion = this.archiveCleanupQueue.enqueue(key, async (context) => {
      let scopedIntent = intent;
      if (intent.deferredWorktrees) {
        const remaining = this.archiveWorktreeReferences.pending(intent);
        if (!remaining.length) return { backend: intent.backend, threadId: intent.threadId, archivedAt: intent.archivedAt, cleanup: [] };
        scopedIntent = { ...intent, deferredWorktrees: remaining };
      }
      startedAt = Date.now();
      backendRegistryLog.info("archive cleanup started", { ...logFields, startedAt, queueWaitMs: startedAt - queuedAt });
      return await this.completeArchivedThreadCleanup({ ...scopedIntent, context,
        onMetadataUnavailable: () => { metadataUnavailable = true; },
        // A saved archive intent cannot authorize deleting a restored thread.
        // Recovery requires current archived membership, including for formerly
        // missing rollouts; it never repeats the provider archive operation.
        ...(resuming ? { requireArchived: true, codexRolloutMissing: false } : {}),
      });
    }, { reportProgress: !resuming });
    void completion.then((response) => {
      const completedAt = Date.now();
      backendRegistryLog.info("archive cleanup completed", { ...logFields, completedAt,
        queueWaitMs: startedAt === undefined ? undefined : startedAt - queuedAt,
        cleanupDurationMs: startedAt === undefined ? undefined : completedAt - startedAt,
        archiveAgeMs: completedAt - intent.archivedAt, worktreeCount: response.cleanup.length,
      });
      for (const outcome of response.cleanup) backendRegistryLog.info("archive cleanup worktree outcome", { ...logFields, ...outcome });
      if (this.pendingArchiveCleanupIntents.get(key) === intent) {
        if (resuming && metadataUnavailable) this.archiveCleanupRetryIntents.set(key, intent);
        this.pendingArchiveCleanupIntents.delete(key);
      }
      // Persist only reference-wait boundaries, not every successful archive.
      if (this.archiveCleanupQueue.pendingKeys().length === 1
        && (this.archiveWorktreeReferences.hasOwners || intent.deferredWorktrees)) this.tryCheckpointArchiveCleanupsForQuit("reference-change");
      queueMicrotask(() => this.dispatchReleasedArchiveCleanups(this.archiveWorktreeReferences.readyIntents(key)));
    }, (error: unknown) => {
      const completedAt = Date.now();
      backendRegistryLog.info("archive cleanup stopped", { ...logFields, completedAt,
        queueWaitMs: (startedAt ?? completedAt) - queuedAt,
        cleanupDurationMs: startedAt === undefined ? 0 : completedAt - startedAt,
        cancelled: error instanceof ArchiveCleanupCancelledError, error: error instanceof Error ? error.message : String(error),
      });
      if (!(this.context.lifecycle.closed && error instanceof ArchiveCleanupCancelledError)
        && this.pendingArchiveCleanupIntents.get(key) === intent) {
        if (resuming && !(error instanceof ArchiveCleanupCancelledError)) this.archiveCleanupRetryIntents.set(key, intent);
        this.pendingArchiveCleanupIntents.delete(key);
      }
    });
    return completion;
  }

  async resumeArchiveCleanupsAtStartup(): Promise<void> {
    if (this.context.lifecycle.closed || this.archiveCleanupResumeStarted || !this.archiveCleanupCheckpointStore) return;
    this.archiveCleanupResumeStarted = true;
    const recovered = this.archiveCleanupCheckpointStore.recover(this.host().runtimeInstanceId, this.host().resolveLiveProfileRuntimeInstanceIdsFn);
    const candidates = [...new Map(recovered.map((intent) => [buildThreadIdentityKey(intent.backend, intent.threadId), intent])).values()]
      .filter((intent) => !this.pendingArchiveCleanupIntents.has(buildThreadIdentityKey(intent.backend, intent.threadId)));
    for (const intent of candidates) for (const worktree of intent.deferredWorktrees ?? []) await this.archiveWorktreeReferences.retain(intent, worktree);
    const remaining = [...candidates.filter((intent) => !intent.deferredWorktrees), ...this.archiveWorktreeReferences.recoveryIntents()];
    for (const intent of remaining) this.pendingArchiveCleanupIntents.set(buildThreadIdentityKey(intent.backend, intent.threadId), intent);
    while (remaining.length > 0 && !this.context.lifecycle.closed) {
      const keys = this.archiveCleanupQueue.pendingKeys();
      const room = ARCHIVE_CLEANUP_QUEUE_LIMIT - keys.length;
      if (room <= 0) {
        await Promise.race(keys.map((key) => this.archiveCleanupQueue.pending(key)!.catch(() => {})));
        continue;
      }
      await Promise.allSettled(remaining.splice(0, room).map((intent) => {
        this.archiveWorktreeReferences.scheduled(intent);
        const completion = this.enqueueArchiveCleanup(intent, true);
        return this.observeArchiveCleanupCompletion(completion, { ...intent, backgroundCleanup: true, reporting: "background" });
      }));
      // Background acknowledgements do not drain the bounded queue. Wait for
      // admitted jobs before taking another chunk of the durable backlog.
      await Promise.allSettled(this.archiveCleanupQueue.pendingKeys().map((key) => this.archiveCleanupQueue.pending(key)!));
    }
    // Recovery claims every saved intent before dispatch. Retire completed
    // claims once the batch drains, even when none retained a reference row;
    // otherwise a crash before clean quit replays those terminal outcomes.
    if (!this.context.lifecycle.closed) this.tryCheckpointArchiveCleanupsForQuit("recovery-drain");
  }

  private async observeArchiveCleanupCompletion(completion: Promise<ArchiveThreadResponse>, params: {
    backend: AppServerBackendKind; threadId: string; archivedAt: number; backgroundCleanup?: boolean; mustComplete?: boolean;
    reporting?: "background";
  }): Promise<ArchiveThreadResponse> {
    const { backend, threadId, archivedAt } = params;
    // Register the result/error observer before returning a background ack.
    // Awaiting callers retain the existing completion and missing-rollout error.
    const observed = completion.catch((error): ArchiveThreadResponse => {
      if (error instanceof ArchiveCleanupCancelledError) {
        if (params.mustComplete) throw new Error(`Codex rollout is already missing, but PwrAgent archive cleanup did not complete: ${error.message}`, { cause: error });
        return { backend, threadId, archivedAt, cleanup: [{
          removedWorktree: false, deletedBranch: false, skippedReason: error.message,
        }] };
      }
      throw error;
    });
    const key = buildThreadIdentityKey(backend, threadId);
    this.archiveCleanupCompletions.set(key, { promise: observed, archivedAt });
    void observed.then(() => {}, () => {}).finally(() => {
      if (this.archiveCleanupCompletions.get(key)?.promise === observed) this.archiveCleanupCompletions.delete(key);
    });
    if (!params.backgroundCleanup) return await observed;
    void observed.then(async (response) => {
      if (this.context.lifecycle.closed) return;
      await this.context.emit({ backend, notification: {
        method: "thread/archiveCleanup/completed",
        params: { threadId, archivedAt, cleanup: response.cleanup, ...(params.reporting ? { reporting: params.reporting } : {}),
          ...(response.threadTitle ? { threadTitle: response.threadTitle } : {}) },
      } });
      backendRegistryLog.info("archive cleanup completion published", { backend, threadId, archivedAt,
        runtimeInstanceId: this.host().runtimeInstanceId, publishedAt: Date.now(), archiveAgeMs: Date.now() - archivedAt,
      });
    }, async (error) => {
      if (this.context.lifecycle.closed) return;
      await this.context.emit({ backend, notification: {
        method: "thread/archiveCleanup/completed",
        params: { threadId, archivedAt, cleanup: [], error: error instanceof Error ? error.message : String(error),
          ...(params.reporting ? { reporting: params.reporting } : {}) },
      } });
      backendRegistryLog.info("archive cleanup completion published", { backend, threadId, archivedAt,
        runtimeInstanceId: this.host().runtimeInstanceId, publishedAt: Date.now(), archiveAgeMs: Date.now() - archivedAt, failed: true,
      });
    }).catch((error) => backendRegistryLog.warn("archive cleanup completion publication failed", { error: String(error) }));
    return { backend, threadId, archivedAt, cleanup: [], cleanupPending: true };
  }

  private async traceArchiveCleanupStage<T>(
    identity: { backend: AppServerBackendKind; threadId: string; archivedAt: number },
    stage: "metadata" | "ungroup" | "worktrees",
    work: () => Promise<T>,
  ): Promise<T> {
    const { backend, threadId, archivedAt } = identity;
    const fields = { backend, threadId, archivedAt, runtimeInstanceId: this.host().runtimeInstanceId, stage };
    const startedAt = Date.now();
    backendRegistryLog.info("archive cleanup stage started", fields);
    try {
      const result = await work();
      backendRegistryLog.info("archive cleanup stage completed", { ...fields, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      backendRegistryLog.info("archive cleanup stage failed", { ...fields, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async completeArchivedThreadCleanup(params: {
    backend: AppServerBackendKind;
    threadId: string;
    archivedAt: number;
    codexRolloutMissing: boolean;
    preserveWorktrees?: boolean;
    messagingCleanup: { error?: string };
    context: ArchiveCleanupContext;
    requireArchived?: boolean;
    deferredWorktrees?: ArchiveCleanupIntent["deferredWorktrees"];
    onMetadataUnavailable?: () => void;
  }): Promise<ArchiveThreadResponse> {
    const { backend, archivedAt, codexRolloutMissing, messagingCleanup, context } = params;
    const result = { threadId: params.threadId };
    const key = buildThreadIdentityKey(backend, result.threadId);
    const superseded = new Set<string>();
    for (const row of params.deferredWorktrees ?? []) if (row.snapshot) {
      const overlay = await this.context.stores.threads.getThreadOverlayState({ backend, threadId: result.threadId });
      if (overlay?.worktreeSnapshots?.some((snapshot) => snapshot.id === row.snapshot!.id && snapshot.state === "restored")) {
        await this.archiveWorktreeReferences.fulfilled(row.worktreePath);
        superseded.add(row.worktreePath);
      } else await this.context.stores.archive.upsertWorktreeSnapshot({ backend, threadId: result.threadId, snapshot: row.snapshot });
    }
    if (superseded.size) params = { ...params, deferredWorktrees: params.deferredWorktrees?.filter((row) => !superseded.has(row.worktreePath)) };
    if (this.cancelledArchiveCleanupKeys.has(key) || this.automaticArchiveReservations.get(key)?.cancelled) throw new ArchiveCleanupCancelledError();
    let cleanupMetadata: ArchiveCleanupMetadata | undefined;
    let cleanupMetadataError: string | undefined;
    try {
      cleanupMetadata = await this.traceArchiveCleanupStage(params, "metadata", async () => {
        const read = async () => {
          let targetThread: AppServerThreadSummary | undefined;
          // A built fleet index holds the target. Discovery refreshes its dirty
          // identities, and removal obtains its own fresh ownership admission.
          const canReuseTarget = this.cleanupInventory.canReuseTarget(context.batch);
          if (!this.context.providers.codex.enrichArchiveCleanupThreads && !canReuseTarget && !params.requireArchived && backend === "codex" && this.context.providers.codex.readArchiveCleanupThreadSummary && !codexRolloutMissing) {
            targetThread = await this.context.providers.codex.readArchiveCleanupThreadSummary(result.threadId, context.checkpoint);
          } else if (isAcpBackendId(backend)) {
            const session = this.context.providers.acp.getSession(backend, result.threadId);
            if (session?.archivedAt) targetThread = this.context.providers.acp.sessionToThreadSummary(session);
          } else if (backend === "claude") {
            targetThread = (await this.context.providers.claude.listThreads({ archived: true }))
              .find((thread) => thread.id === result.threadId);
          }
          if (targetThread) {
            const readOverlays = this.context.stores.archive.getArchiveCleanupOverlayStates ?? this.context.stores.threads.getThreadOverlayStates;
            await context.checkpoint();
            const overlays = await readOverlays.call(this.context.stores.archive, { backend, threadIds: [result.threadId] });
            targetThread = { ...targetThread, linkedDirectories: withRetainedWorktrees(mergeThreadLinkedDirectories([
              ...targetThread.linkedDirectories, ...(overlays[result.threadId]?.extraLinkedDirectories ?? []),
            ]), overlays[result.threadId]) };
          }
          const needsWorktreeOwnership = !params.preserveWorktrees && (isAcpBackendId(backend) || !targetThread
            || targetThread.linkedDirectories.some((directory) => Boolean(linkedDirectoryWorktreePath(directory))));
          return await this.cleanupInventory.readThreadForArchiveCleanup({
            backend, threadId: result.threadId, context, codexRolloutMissing,
            targetThread: needsWorktreeOwnership ? undefined : targetThread,
          });
        };
        return context.withInventory ? await context.withInventory(read) : await read();
      });
    } catch (error) {
      context.assertCurrent();
      cleanupMetadataError = error instanceof Error ? error.message : String(error);
      params.onMetadataUnavailable?.();
      backendRegistryLog.warn("archive cleanup metadata lookup failed", { backend, threadId: result.threadId, error: cleanupMetadataError });
    }
    const finish = async (): Promise<ArchiveThreadResponse> => {
      // A shared checkout may have waited while its preceding owner finished
      // archiving. Refresh that evidence before acting on the old active list.
      if (cleanupMetadata?.workspaceRevision !== undefined && cleanupMetadata.workspaceRevision !== this.archiveWorkspaceRevision) {
        cleanupMetadata = await this.cleanupInventory.findThreadForArchiveCleanup({ backend, threadId: result.threadId, context, codexRolloutMissing });
      }
      let ungroupError: string | undefined;
      try {
        // Startup recovery can reach this stage without a foreground mutation
        // in this process. Preserve nested tray members before the legacy
        // top-level ungrouping fallback inspects them.
        context.assertCurrent();
        await this.observeArchivedThreads(
          [{ backend, threadId: result.threadId }], params.archivedAt, { promoteSubthreads: true },
        );
        await this.traceArchiveCleanupStage(params, "ungroup", async () => await this.ungroupChildrenOfArchivedThread({
          backend, activeThreads: cleanupMetadata?.activeChildren ?? cleanupMetadata?.activeThreads ?? [], parentThreadId: result.threadId,
          overlaysByThreadKey: cleanupMetadata?.overlaysByThreadKey, context,
          legacyParentBackends: cleanupMetadata?.legacyParentBackends ?? (cleanupMetadata ? new Set([...cleanupMetadata.activeThreads, ...cleanupMetadata.archivedThreads]
            .filter((thread) => thread.id === result.threadId).map((thread) => thread.source)) : undefined),
        }));
      } catch (error) {
        context.assertCurrent();
        ungroupError = error instanceof Error ? error.message : String(error);
        backendRegistryLog.warn("archive thread child ungrouping failed", { backend, threadId: result.threadId, error: ungroupError });
      }
      const cleanup = await this.traceArchiveCleanupStage(params, "worktrees", async () => params.preserveWorktrees ? [] : cleanupMetadata
        ? await this.archiveThreadWorktrees({
            backend, activeThreads: cleanupMetadata.activeThreads, archivedThreads: cleanupMetadata.archivedThreads,
            thread: cleanupMetadata.thread, context, codexRolloutMissing, worktreeEvidence: cleanupMetadata.worktreeEvidence,
            deferredWorktrees: params.deferredWorktrees, workspaceRevision: cleanupMetadata.workspaceRevision,
            ownershipPaths: cleanupMetadata.ownershipPaths,
          })
        : this.buildArchiveCleanupMetadataSkippedResult({ backend, threadId: result.threadId, error: cleanupMetadataError }));
      if (codexRolloutMissing) {
        const cleanupFailures = [
          cleanupMetadataError
            ? `metadata lookup failed: ${cleanupMetadataError}`
            : undefined,
          messagingCleanup.error
            ? `messaging cleanup failed: ${messagingCleanup.error}`
            : undefined,
          ungroupError
            ? `child ungrouping failed: ${ungroupError}`
            : undefined,
          ...cleanup.map((item) => {
            if (!item.error) {
              return undefined;
            }
            const worktreeContext = item.worktreePath
              ? ` for ${item.worktreePath}`
              : "";
            return `worktree cleanup failed${worktreeContext}: ${item.error}`;
          }),
        ].filter((failure): failure is string => Boolean(failure));
        if (cleanupFailures.length > 0) {
          throw new Error(
            `Codex rollout is already missing, but PwrAgent archive cleanup did not complete: ${cleanupFailures.join("; ")}`,
          );
        }

        await this.context.stores.archive.setThreadArchiveTombstone({
          backend,
          threadId: result.threadId,
          archivedAt,
        });
        // A missing rollout can leave this owner in the provider's active list.
        // Subsequent jobs must apply the new tombstone before checking sharing.
        this.cleanupInventory.noteArchiveFleetChange({ backend, threadId: result.threadId }, "overlay", "tombstone");
        this.archiveWorkspaceRevision += 1;
        await this.observeReleasedArchiveReference(backend, result.threadId, true);
        this.host().pendingStartedThreads.delete(key);
        this.host().invalidateThreadListCache(backend);
        backendRegistryLog.warn("codex archive tombstoned missing rollout", {
          backend,
          threadId: result.threadId,
        });
      }

      const threadTitle = cleanupMetadata?.thread.title?.trim();
      return {
        backend,
        threadId: result.threadId,
        archivedAt,
        cleanup,
        ...(threadTitle ? { threadTitle } : {}),
      };
    };
    if (!context.withWorktree || params.preserveWorktrees || !cleanupMetadata) return await finish();
    const canonical = canonicalWorktreePaths();
    const scopes = [...new Set(await Promise.all(cleanupMetadata.thread.linkedDirectories.flatMap((directory) => {
      const worktreePath = linkedDirectoryWorktreePath(directory);
      return worktreePath ? [worktreePath] : [];
    }).map(async (worktreePath) => await canonical(backend === "codex"
      ? await this.worktreeContainerService.containerPath(worktreePath) ?? worktreePath : worktreePath))))].sort();
    // A deterministic acquisition order also covers multi-checkout threads;
    // retain the locks through tombstone and snapshot publication.
    const locked = async (index: number): Promise<ArchiveThreadResponse> => index === scopes.length
      ? await finish() : await context.withWorktree!(scopes[index]!, async () => await locked(index + 1));
    return await locked(0);
  }

  private buildArchiveCleanupMetadataSkippedResult(params: {
    backend: AppServerBackendKind;
    threadId: string;
    error?: string;
  }): ArchiveThreadCleanupResult[] {
    backendRegistryLog.warn(
      "archive thread worktree cleanup skipped: metadata unavailable",
      {
        backend: params.backend,
        threadId: params.threadId,
        skippedReason: params.error
          ? `Unable to load thread metadata for archive cleanup: ${params.error}`
          : "Unable to load thread metadata for archive cleanup.",
      },
    );

    return [
      {
        removedWorktree: false,
        deletedBranch: false,
        skippedReason: params.error
          ? `Unable to load thread metadata for archive cleanup: ${params.error}`
          : "Unable to load thread metadata for archive cleanup.",
      },
    ];
  }

  async archiveTokenMiserThread(threadId: string): Promise<void> {
    try {
      await this.host().tokenMiserStore?.archiveThread(threadId);
    } catch (error) {
      // Codex has already archived the thread. Retention failures must not
      // prevent binding revocation, child cleanup, bookkeeping or publication.
      backendRegistryLog.warn("Token Miser archive retention failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async restoreTokenMiserThread(threadId: string): Promise<void> {
    try {
      await this.host().tokenMiserStore?.restoreThread(threadId);
    } catch (error) {
      // Codex restoration already succeeded. The retained archive marker
      // keeps originals unavailable while desktop restoration still finishes.
      backendRegistryLog.warn("Token Miser restore retention failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async restoreThread(
    request: RestoreThreadRequest,
  ): Promise<RestoreThreadResponse> {
    return await this.withThreadLifecycleMutation(request, async () => await this.restoreThreadWithoutLifecycleLock(request));
  }

  private async restoreThreadWithoutLifecycleLock(request: RestoreThreadRequest): Promise<RestoreThreadResponse> {
    const backend = request.backend ?? "codex";
    if (backend === "claude") {
      const archivedThread = (await this.context.providers.claude.listThreads({ archived: true })).find((thread) => thread.id === request.threadId);
      if (!archivedThread) throw new Error("Archived Claude thread metadata was not found.");
      const worktrees = await this.restoreThreadWorktrees({ backend, threadId: request.threadId, thread: archivedThread });
      const failures = worktrees.filter((worktree) => worktree.error
        || (!worktree.restored && worktree.skippedReason !== "Worktree path already exists."));
      if (failures.length) {
        throw new Error(`Claude worktree restoration failed; the thread remains archived: ${failures.map((worktree) =>
          `${worktree.worktreePath}: ${worktree.error ?? worktree.skippedReason}`).join("; ")}`);
      }
      await this.withArchiveWorkspaceWrite(archiveWorkspacePaths(archivedThread), async () => await this.context.providers.claude.setArchived(request.threadId, false));
      const restoredAt = Date.now();
      await this.context.stores.archive.setThreadArchiveTombstone({ backend, threadId: request.threadId, restoredAt });
      this.clearArchivedMessagingCleanupCache({ backend, threadId: request.threadId });
      this.host().invalidateThreadListCache(backend);
      await this.context.emit({ backend, notification: { method: "thread/unarchived", params: { threadId: request.threadId } } });
      return { backend, threadId: request.threadId, restoredAt, worktrees };
    }
    if (isAcpBackendId(backend)) {
      return await this.restoreAcpThread({
        backend,
        threadId: request.threadId,
      });
    }
    const archivedThread = await this.findThreadForRestoreWorktrees({
      backend,
      threadId: request.threadId,
    });
    const result = await this.withArchiveWorkspaceWrite(archivedThread ? archiveWorkspacePaths(archivedThread) : [], async () =>
      await this.host().withCodexThreadClient(request.threadId, async (client) => await this.restoreWithClient(client, request.threadId)),
    );
    if (backend === "codex") {
      await this.restoreTokenMiserThread(result.threadId);
      await this.context.stores.archive.setThreadArchiveTombstone({
        backend,
        threadId: result.threadId,
        archivedAt: undefined,
        restoredAt: Date.now(),
      });
    }
    this.host().invalidateThreadListCache(backend);
    this.invalidateArchiveCleanupReads(backend, undefined, true, result.threadId, [], "active");
    this.clearArchivedMessagingCleanupCache({
      backend,
      threadId: result.threadId,
    });
    this.archiveWorktreeReferences.forgetOwner(buildThreadIdentityKey(backend, result.threadId));
    this.tryCheckpointArchiveCleanupsForQuit("reference-change");
    const worktrees = await this.restoreThreadWorktrees({
      backend,
      threadId: result.threadId,
      thread: archivedThread,
    });

    return {
      backend,
      threadId: result.threadId,
      restoredAt: Date.now(),
      worktrees,
    };
  }

  private async archiveAcpThread(params: {
    backend: AcpBackendId;
    threadId: string;
    backgroundCleanup?: boolean;
    preserveWorktrees?: boolean;
  }, beforeMutation?: () => Promise<() => void>, finishMutation?: (archived?: true) => void): Promise<ArchiveThreadResponse> {
    let session = this.context.providers.acp.getSession(params.backend, params.threadId);
    if (!session) {
      throw new Error(`ACP thread not found: ${params.threadId}`);
    }
    const assertAdmission = await beforeMutation?.();
    assertAdmission?.();
    // Listing can yield to a prompt or session update; do not overwrite it
    // with the pre-discovery snapshot.
    session = this.context.providers.acp.getSession(params.backend, params.threadId);
    if (!session) throw new Error(`ACP thread not found: ${params.threadId}`);
    const archivedAt = Date.now();
    this.context.providers.acp.upsertSession({
      ...session,
      archivedAt,
      updatedAt: Math.max(session.updatedAt, archivedAt),
    });
    backendRegistryLog.info("thread archive mutation completed", {
      backend: params.backend, threadId: params.threadId, runtimeInstanceId: this.host().runtimeInstanceId, archivedAt,
    });
    await this.observeArchivedThreads([{ backend: params.backend, threadId: params.threadId }], archivedAt, { promoteSubthreads: true });
    this.host().invalidateThreadListCache(params.backend);
    this.invalidateArchiveCleanupReads(params.backend, undefined, true, params.threadId, [], "archived");
    // Archival on ACP is a local store write, with no provider to announce it.
    // Say it in the same words Codex uses, because everything downstream is
    // written against the notification rather than against a backend: the
    // information store records the fact here, and messaging revokes the
    // thread's Default Agent assignments. Without this an archived ACP thread
    // is invisible to both -- it simply stops appearing in listings, which no
    // consumer can tell apart from a thread it has not seen lately.
    await this.context.emit({
      backend: params.backend,
      notification: {
        method: "thread/archived",
        params: { threadId: params.threadId },
      },
    });
    await this.cleanupMessagingForArchivedThread({
      backend: params.backend,
      threadId: params.threadId,
      origin: "thread-archive",
    });
    const completion = this.enqueueArchiveCleanup({ backend: params.backend, threadId: params.threadId, archivedAt, codexRolloutMissing: false,
      preserveWorktrees: params.preserveWorktrees, messagingCleanup: {} });
    finishMutation?.(true);
    return await this.observeArchiveCleanupCompletion(completion, { ...params, archivedAt });
  }

  private async restoreAcpThread(params: {
    backend: AcpBackendId;
    threadId: string;
  }): Promise<RestoreThreadResponse> {
    const session = this.context.providers.acp.getSession(params.backend, params.threadId);
    if (!session?.archivedAt) {
      throw new Error(`Archived ACP thread not found: ${params.threadId}`);
    }
    const thread = this.context.providers.acp.sessionToThreadSummary(session);
    return await this.withArchiveWorkspaceWrite(archiveWorkspacePaths(thread), async () => {
      const worktrees = await this.restoreThreadWorktrees({ ...params, thread });
      const failures = worktrees.filter((worktree) => worktree.error
        || (!worktree.restored && worktree.skippedReason !== "Worktree path already exists."));
      if (failures.length) throw new Error(`ACP worktree restoration failed; the thread remains archived: ${failures.map((worktree) =>
        `${worktree.worktreePath}: ${worktree.error ?? worktree.skippedReason}`).join("; ")}`);
      // Even a previous failed provider load may have recreated the checkout.
      // Keep the archive marker until both checkout validation and protocol load
      // succeed, and preserve runtime metadata reported during that load.
      const overlay = await this.context.stores.threads.getThreadOverlayState(params);
      if (overlay?.worktreeSnapshots?.some((snapshot) => snapshot.state === "restored")) {
        try { await this.context.providers.acp.restoreWorktreeSession(params.backend, params.threadId); }
        catch (error) { throw new Error(`ACP session restoration failed; the thread remains archived: ${error instanceof Error ? error.message : String(error)}`); }
      }
      const restoredAt = Date.now();
      const restoredSession = { ...this.context.providers.acp.getSession(params.backend, params.threadId) ?? session };
      delete restoredSession.archivedAt;
      this.context.providers.acp.upsertSession({
        ...restoredSession,
        updatedAt: Math.max(restoredSession.updatedAt, restoredAt),
      });
      await this.context.stores.archive.setThreadArchiveTombstone({ ...params, restoredAt });
      this.host().invalidateThreadListCache(params.backend, true, params.threadId);
      this.clearArchivedMessagingCleanupCache({
        backend: params.backend,
        threadId: params.threadId,
      });
      // The counterpart to the archive emit above. This is the only report a
      // restore ever makes: a listing cannot carry the news, because an
      // unarchived thread is one that has merely started appearing again.
      await this.context.emit({
        backend: params.backend,
        notification: {
          method: "thread/unarchived",
          params: { threadId: params.threadId },
        },
      });
      return {
        backend: params.backend,
        threadId: params.threadId,
        restoredAt,
        worktrees,
      };
    });
  }

  async archiveWorktree(
    request: ArchiveWorktreeRequest,
  ): Promise<ArchiveWorktreeResponse> {
    const snapshot = await this.host().worktreeArchiveService.archive({
      backend: request.backend,
      threadId: request.threadId,
      worktreePath: request.worktreePath,
      repositoryPath: request.repositoryPath,
    });
    await this.context.stores.archive.upsertWorktreeSnapshot({
      backend: request.backend,
      threadId: request.threadId,
      snapshot,
    });

    return {
      backend: request.backend,
      threadId: request.threadId,
      archivedAt: snapshot.archivedAt ?? Date.now(),
      snapshot,
    };
  }

  async withHandoffWorktreeAccess<T>(
    identity: { backend: AppServerBackendKind; threadId: string },
    worktreePath: string,
    workspaceWriteKey: string,
    handoff: (access: HandoffSourceWorktreeAccess) => Promise<T>,
  ): Promise<T> {
    const scope = new ArchiveWorkspaceAdmission(buildThreadIdentityKey(identity.backend, identity.threadId), worktreePath);
    const admission = { ...identity, worktreePath, scope };
    // The handoff already holds a write for the source. Only that write
    // may overlap this admission; other writers still fence it.
    this.archiveWorktreeRemovalAdmissions.add(admission);
    this.archiveWorkspaceOwnership.beginAdmission(scope, workspaceWriteKey);
    const assertExclusive = () => {
      if (this.context.lifecycle.closed) throw new ArchiveCleanupCancelledError();
      scope.assertCurrent(this.archiveWorkspaceMutations());
    };
    const verifyExclusive = async () => {
      if (this.host().isCodexBootstrapDeferredFn()) throw new Error("Could not verify which threads use it.");
      const discovery = { ...identity, ownershipScope: worktreePath, removalAdmission: scope };
      const inventory = this.context.providers.codex.listArchiveCleanupThreadsPage
        ? await this.cleanupInventory.readPacedArchiveCleanupInventory(discovery)
        : await this.cleanupInventory.findThreadForArchiveCleanup(discovery);
      const { users, external } = await this.readCanonicalArchiveOwnership(inventory, worktreePath);
      if (users.some((thread) => thread.id !== identity.threadId || thread.source !== identity.backend)) {
        throw new Error("The worktree is still used by another active thread.");
      }
      if (external) throw new Error("The worktree is externally managed.");
      await scope.prepare(this.archiveWorkspaceMutationsFor(scope));
      assertExclusive();
      scope.reserve(this.archiveWorkspaceMutations());
    };
    try {
      try {
        await verifyExclusive();
      } catch (error) {
        if (this.context.lifecycle.closed) throw error;
        this.archiveWorktreeRemovalAdmissions.delete(admission);
        return await handoff({ keepReason: error instanceof Error ? error.message : String(error) });
      }
      return await handoff({
        assertExclusive,
        beforeRemove: async () => {
          await verifyExclusive();
          return assertExclusive;
        },
      });
    } finally {
      this.archiveWorktreeRemovalAdmissions.delete(admission);
    }
  }

  async restoreWorktree(
    request: RestoreWorktreeRequest,
  ): Promise<RestoreWorktreeResponse> {
    const overlay = await this.context.stores.threads.getThreadOverlayState({
      backend: request.backend,
      threadId: request.threadId,
    });
    const snapshot = (overlay?.worktreeSnapshots ?? []).find((candidate) => {
      if (request.snapshotRef) {
        return candidate.snapshotRef === request.snapshotRef;
      }

      return candidate.worktreePath === request.worktreePath;
    });

    if (!snapshot) {
      throw new Error("No archived worktree snapshot is available for this thread.");
    }
    if (snapshot.state === "hibernated") {
      // An explicit Restore targets this checkpoint even with no active CWD.
      this.undeliveredCheckoutRestoreFailures.delete(buildThreadIdentityKey(request.backend, request.threadId));
      await this.restoreHibernatedCheckout(request, snapshot.id);
      const restored = (await this.context.stores.threads.getThreadOverlayState(request))?.worktreeSnapshots
        ?.find((candidate) => candidate.id === snapshot.id) ?? snapshot;
      return { backend: request.backend, threadId: request.threadId, restoredAt: restored.restoredAt ?? Date.now(), snapshot: restored };
    }

    const restoredSnapshot = await this.withArchiveWorkspaceWrite([request.worktreePath], async () => await this.host().worktreeArchiveService.restore({
      backend: request.backend,
      threadId: request.threadId,
      worktreePath: request.worktreePath,
      repositoryPath: request.repositoryPath ?? snapshot.repositoryPath,
      snapshotRef: request.snapshotRef ?? snapshot.snapshotRef,
      snapshotCommit: snapshot.snapshotCommit,
      snapshot,
    }));
    await this.context.stores.archive.upsertWorktreeSnapshot({
      backend: request.backend,
      threadId: request.threadId,
      snapshot: restoredSnapshot,
    });

    return {
      backend: request.backend,
      threadId: request.threadId,
      restoredAt: restoredSnapshot.restoredAt ?? Date.now(),
      snapshot: restoredSnapshot,
    };
  }

  scheduleThreadListArchiveStateCleanup(params: {
    archived?: boolean;
    backend: AppServerBackendKind;
    completeInventory: boolean;
    observationSequence: number;
    threads: AppServerThreadSummary[];
  }): void {
    void this.handleThreadListArchiveState(params).catch((error) => {
      backendRegistryLog.warn("thread list archive state cleanup failed", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleThreadListArchiveState(params: {
    archived?: boolean;
    backend: AppServerBackendKind;
    completeInventory: boolean;
    observationSequence: number;
    threads: AppServerThreadSummary[];
  }): Promise<void> {
    if (params.backend === "codex" && this.context.providers.codex.isAuthenticationRequired?.()) return;

    const previous = this.activeObservationsByBackend.get(params.backend);
    if (params.archived === true) {
      await Promise.all(
        params.threads
          .filter((thread) => (previous?.get(thread.id) ?? 0) <= params.observationSequence)
          .map((thread) => this.cleanupMessagingForArchivedThread({
            backend: params.backend,
            threadId: thread.id,
            origin: "state-refresh",
          })),
      );
      return;
    }

    // Only a complete read can forget IDs. Every returned row, including a
    // partial first page, can protect its binding against older archive reads.
    const active = params.completeInventory || !previous ? new Map<string, number>() : previous;
    let addedActiveThread = false;
    for (const thread of params.threads) {
      const lastSeen = previous?.get(thread.id);
      if (previous && lastSeen === undefined) {
        addedActiveThread = true;
        this.recordArchiveWorkspaceChange(buildThreadIdentityKey(params.backend, thread.id), archiveWorkspacePaths(thread));
      }
      active.set(thread.id, Math.max(lastSeen ?? 0, params.observationSequence));
    }
    const missingThreadIds = new Set<string>();
    if (params.completeInventory && previous) {
      for (const [id, lastSeen] of previous) {
        if (lastSeen > params.observationSequence) active.set(id, lastSeen);
        else if (!active.has(id)) missingThreadIds.add(id);
      }
    }
    this.activeObservationsByBackend.set(params.backend, active);
    if (addedActiveThread || missingThreadIds.size > 0) {
      this.invalidateArchiveCleanupReads(params.backend, undefined, false);
    }
    if (!params.completeInventory) return;
    const store = this.resolveMessagingArchiveCleanupStore();
    if (store) {
      try {
        const bindings = await store.findActiveBindingsForBackend({ backend: params.backend });
        for (const binding of bindings) {
          if (!active.has(binding.threadId)) missingThreadIds.add(binding.threadId);
        }
      } catch (error) {
        backendRegistryLog.warn("archived binding lookup failed", {
          backend: params.backend,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (missingThreadIds.size === 0 || this.context.lifecycle.closed) return;

    try {
      // Both transition and binding candidates need the same archive authority.
      // Turn/status invalidations still refresh active summaries, but cannot
      // change this membership. Use cheap IDs and one shared paginated walk.
      const evidence = await this.archiveCleanupReads.read(params.backend, async () => {
        if (this.context.lifecycle.closed) throw new Error("Registry closed during archive cleanup.");
        let incomplete = false;
        const threads = await this.host().getClient(params.backend).listThreads({
          archived: true,
          enrichDirectories: false,
        }, {
          callerReason: "archive-cleanup",
          ownerId: this.host().threadListCacheOwnerId,
        }, () => { incomplete = true; });
        if (incomplete) throw new Error("Archived thread discovery ended before the cursor was exhausted.");
        return new Set(threads.map((thread) => thread.id));
      });
      if (this.context.lifecycle.closed || !this.archiveCleanupReads.isCurrent(params.backend, evidence)) return;
      const activeThreadIds = this.activeObservationsByBackend.get(params.backend);
      await Promise.all(
        [...missingThreadIds]
          .filter((id) => evidence.threadIds.has(id) && !activeThreadIds?.has(id))
          .map((threadId) => this.cleanupMessagingForArchivedThread({
            backend: params.backend,
            threadId,
            origin: "state-refresh",
          })),
      );
    } catch (error) {
      backendRegistryLog.warn("archived thread cleanup membership read failed", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveMessagingArchiveCleanupStore(): MessagingArchiveCleanupStore | undefined {
    const host = this.host();
    if (host.messagingStore === null) {
      return undefined;
    }
    if (host.messagingStore) {
      return host.messagingStore;
    }

    try {
      return getDesktopMessagingStore();
    } catch (error) {
      backendRegistryLog.debug("messaging store unavailable for archive cleanup", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async cleanupMessagingForArchivedThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    origin: "state-refresh" | "thread-archive";
  }): Promise<MessagingArchiveCleanupResult> {
    const key = this.archivedMessagingCleanupKey(params);
    const existing = this.archivedMessagingCleanupInFlight.get(key);
    if (existing) {
      return await existing;
    }
    if (this.archivedMessagingCleanupCompleted.has(key)) {
      return { pendingIntentCount: 0, revokedCount: 0 };
    }

    const generation = this.archivedMessagingCleanupGeneration.get(key) ?? 0;
    const cleanup = this.runMessagingCleanupForArchivedThread(params)
      .then((result) => {
        if (
          (this.archivedMessagingCleanupGeneration.get(key) ?? 0) === generation &&
          (result.pendingIntentCount > 0 || result.revokedCount > 0)
        ) {
          this.archivedMessagingCleanupCompleted.add(key);
        }
        return result;
      })
      .finally(() => {
        this.archivedMessagingCleanupInFlight.delete(key);
      });
    this.archivedMessagingCleanupInFlight.set(key, cleanup);
    return await cleanup;
  }

  clearArchivedMessagingCleanupCache(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): void {
    const key = this.archivedMessagingCleanupKey(params);
    this.archivedMessagingCleanupCompleted.delete(key);
    this.archivedMessagingCleanupGeneration.set(
      key,
      (this.archivedMessagingCleanupGeneration.get(key) ?? 0) + 1,
    );
  }

  private archivedMessagingCleanupKey(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): string {
    return buildThreadIdentityKey(params.backend, params.threadId);
  }

  private async runMessagingCleanupForArchivedThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    origin: "state-refresh" | "thread-archive";
  }): Promise<MessagingArchiveCleanupResult> {
    try {
      const store = this.resolveMessagingArchiveCleanupStore();
      const pendingIntentIds = store
        ? await store.deletePendingIntentsForThread({
            backend: params.backend,
            threadId: params.threadId,
          })
        : [];

      if (this.messagingArchiveCleaner) {
        const revokeResult =
          await this.messagingArchiveCleaner.requestBindingRevokeAllForThread({
            backend: params.backend,
            threadId: params.threadId,
            origin: "thread-archive",
          });

        if (revokeResult.revokedCount > 0 || pendingIntentIds.length > 0) {
          backendRegistryLog.info("archived thread messaging cleanup completed", {
            backend: params.backend,
            notifiedCount: revokeResult.notifiedCount,
            origin: params.origin,
            pendingIntentCount: pendingIntentIds.length,
            revokedCount: revokeResult.revokedCount,
            threadId: params.threadId,
          });
        }

        return {
          notifiedCount: revokeResult.notifiedCount,
          pendingIntentCount: pendingIntentIds.length,
          revokedCount: revokeResult.revokedCount,
        };
      }

      if (!store) {
        return { pendingIntentCount: 0, revokedCount: 0 };
      }

      const bindings = await store.findActiveBindingsForThread({
        backend: params.backend,
        threadId: params.threadId,
      });

      for (const binding of bindings) {
        await store.revokeBinding({ bindingId: binding.id });
        await this.recordMessagingBindingUnbound({
          backend: params.backend,
          binding,
          threadId: params.threadId,
        });
      }

      if (bindings.length > 0 || pendingIntentIds.length > 0) {
        backendRegistryLog.info("archived thread messaging cleanup completed", {
          backend: params.backend,
          origin: params.origin,
          pendingIntentCount: pendingIntentIds.length,
          revokedCount: bindings.length,
          threadId: params.threadId,
        });
      }

      return {
        pendingIntentCount: pendingIntentIds.length,
        revokedCount: bindings.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      backendRegistryLog.warn("archived thread messaging cleanup failed", {
        backend: params.backend,
        error: message,
        origin: params.origin,
        threadId: params.threadId,
      });
      return {
        error: message,
        pendingIntentCount: 0,
        revokedCount: 0,
      };
    }
  }

  private async recordMessagingBindingUnbound(params: {
    backend: AppServerBackendKind;
    binding: Awaited<ReturnType<MessagingArchiveCleanupStore["findActiveBindingsForThread"]>>[number];
    threadId: string;
  }): Promise<void> {
    const conversation = params.binding.channel.conversation;
    const transition: ThreadMessagingBindingTransition = {
      id: randomUUID(),
      action: "unbound",
      bindingId: params.binding.id,
      platform: params.binding.channel.channel,
      conversationKind: conversation.kind,
      conversationTitle: conversation.title,
      parentTitle: conversation.parentTitle,
      ancestorTitle: conversation.ancestorTitle,
      occurredAt: Date.now(),
    };
    try {
      await this.context.stores.messaging.appendMessagingBindingTransition({
        backend: params.backend,
        threadId: params.threadId,
        transition,
      });
    } catch (error) {
      backendRegistryLog.warn("archived thread messaging audit failed", {
        bindingId: params.binding.id,
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
      });
    }
  }

  private async archiveWithClient(
    client: BackendClient,
    threadId: string,
  ): Promise<{ threadId: string }> {
    if (!client.archiveThread) {
      throw new Error("Selected backend does not support thread archiving");
    }

    return await client.archiveThread({ threadId });
  }

  /** Backfill only archived checkouts; never archive the provider thread again.
   * Discovery is one complete read, while each removal retains fresh ownership
   * admission and the ordinary snapshot/restore persistence boundary. */
  repairArchivedThreadWorktrees(options: {
    dryRun?: boolean;
    /** With dryRun: also list PwrAgent worktrees no thread refers to. */
    includeCheckoutInventory?: boolean;
    /** Limit removal to these reviewed checkouts. Empty folders only when asked. */
    select?: { worktreePaths: ReadonlySet<string>; emptyFolders: boolean;
      /** Reviewed approvals to snapshot past the normal limit, by normalized
       * checkout path. Each applies only to that checkout's own removal. */
      snapshotLimits?: ReadonlyMap<string, number>;
      /** The operator's approvals to unlock someone else's lock, by
       * normalized checkout path, with the lock text they saw. */
      lockApprovals?: ReadonlyMap<string, string>;
      /** The archived thread each checkout must still belong to, by
       * normalized checkout path, as a thread identity key. Another owner
       * keeps the checkout. */
      expectedOwners?: ReadonlyMap<string, string> };
    onProgress?: (completed: number, total: number, report?: ArchivedWorktreeRepairReport) => void;
    onItem?: (item: Pick<ThreadMaintenanceRunItem, "status" | "stage" | "reason" | "detail" | "lockReason"> & { path: string }) => void;
    stopped?: () => boolean;
  } = {}): Promise<ArchivedWorktreeRepairReport> {
    // A manual sweep joins startup repair rather than queuing duplicate removals.
    // Read-only audits never join a mutating pass. A reviewed selection waits
    // for a running pass, then runs on its own: joining would report on
    // checkouts nobody selected.
    if (options.dryRun) return this.runArchivedThreadWorktreeRepair(options);
    if (this.archivedWorktreeRepair && !options.select) return this.archivedWorktreeRepair;
    const previous = this.archivedWorktreeRepair?.catch(() => undefined);
    const running = (async () => {
      await previous;
      return await this.runArchivedThreadWorktreeRepair(options);
    })().finally(() => {
      if (this.archivedWorktreeRepair === running) this.archivedWorktreeRepair = undefined;
    });
    this.archivedWorktreeRepair = running;
    return running;
  }

  /** Read-only list of archived threads' checkouts still on disk, for review. */
  async auditArchivedCheckouts(onProgress?: (progress: MaintenanceDiscoveryProgress) => void): Promise<{
    candidates: Array<{ backend: AppServerBackendKind; threadId: string; worktreePath: string }>;
    kept: Record<string, number>;
    emptyFolders: number;
    unreferenced: string[];
    unreferencedUnavailable?: string;
    unreferencedTruncated?: boolean;
    inventory?: ArchivedWorktreeRepairReport["inventory"];
  }> {
    const report = await this.runArchivedThreadWorktreeRepair({ dryRun: true, includeCheckoutInventory: true, onDiscoveryProgress: onProgress });
    return {
      candidates: report.candidates,
      kept: archivedWorktreeKeptReasons(report),
      emptyFolders: report.emptyContainerCandidates.length,
      unreferenced: report.unreferencedWorktrees ?? [],
      ...(report.unreferencedUnavailable ? { unreferencedUnavailable: report.unreferencedUnavailable } : {}),
      ...(report.unreferencedTruncated ? { unreferencedTruncated: true } : {}),
      ...(report.inventory ? { inventory: report.inventory } : {}),
    };
  }

  /** Report only checkouts positively associated with this profile's provider
   * inventory. Other folders are neither measured nor offered for removal. */
  private async describeMaintenanceCheckoutInventory(
    inventory: Pick<ArchiveCleanupMetadata, "activeThreads" | "archivedThreads" | "overlaysByThreadKey">,
    report: ArchivedWorktreeRepairReport,
    onProgress?: (progress: MaintenanceDiscoveryProgress) => void,
  ): Promise<void> {
    const threads = [...inventory.activeThreads, ...inventory.archivedThreads];
    const candidates = threads.map((thread) => ({ thread,
      overlay: inventory.overlaysByThreadKey?.get(buildThreadIdentityKey(thread.source, thread.id)) }));
    const checkouts = await resolveOwnedMaintenanceCheckouts(candidates, onProgress);
    const providers = new Map<string, number>();
    for (const thread of threads) providers.set(thread.source, (providers.get(thread.source) ?? 0) + 1);
    const activeKeys = new Set(inventory.activeThreads.map((thread) => buildThreadIdentityKey(thread.source, thread.id)));
    report.inventory = { roots: [], paths: checkouts.map((item) => item.path),
      keptPaths: checkouts.flatMap((item) => {
        const protectedOwner = report.protectedWorktreeDetails.find((row) =>
          normalizeWorktreePathForComparison(row.worktreePath) === normalizeWorktreePathForComparison(item.path));
        const reason = protectedOwner?.externallyManaged ? "Externally managed"
          : item.candidates.some((owner) => activeKeys.has(buildThreadIdentityKey(owner.thread.source, owner.thread.id)))
            ? "Used by an active thread" : undefined;
        return reason ? [{ path: item.path, reason }] : [];
      }),
      providers: [...providers].map(([backend, count]) => ({ backend, threads: count })),
      owners: checkouts.map((item) => ({ ...item, threads: item.candidates.map((candidate) =>
        maintenanceKeptThread(candidate, checkoutHibernationLastActivity(candidate))) })),
    };
    report.unreferencedWorktrees = [];
  }

  /** Remove only reviewed archived checkouts. Each removal still takes fresh
   * ownership admission and snapshots changes, exactly like the repair pass. */
  async removeArchivedCheckouts(selection: { worktreePaths: string[]; emptyFolders: boolean;
    /** Reviewed approvals to snapshot an over-limit checkout, by path. */
    snapshotLimits?: { worktreePath: string; bytes: number }[];
    /** The operator's approvals to unlock someone else's lock, by path, with the lock text they saw. */
    unlockApprovals?: { worktreePath: string; lockReason: string }[];
    /** The archived thread each checkout must still belong to, by path. */
    expectedOwners?: { worktreePath: string; backend: AppServerBackendKind; threadId: string }[] }, options?: {
    onItem: (item: Pick<ThreadMaintenanceRunItem, "status" | "stage" | "reason" | "detail" | "lockReason"> & { path: string }) => void;
    stopped: () => boolean;
  }): Promise<{
    removed: { worktreePath: string }[];
    kept: { worktreePath: string; reason: string; lock?: WorktreeLockedKept }[];
    failed: { worktreePath: string; message: string }[];
    emptyFoldersRemoved: number;
    emptyFoldersFailed: { worktreePath: string; message: string }[];
  }> {
    const selected = new Set(selection.worktreePaths.map(normalizeWorktreePathForComparison));
    const report = await this.repairArchivedThreadWorktrees({
      select: { worktreePaths: selected, emptyFolders: selection.emptyFolders,
        ...(selection.snapshotLimits?.length ? { snapshotLimits: new Map(selection.snapshotLimits.map((limit) =>
          [normalizeWorktreePathForComparison(limit.worktreePath), limit.bytes])) } : {}),
        ...(selection.unlockApprovals?.length ? { lockApprovals: new Map(selection.unlockApprovals.map((approval) =>
          [normalizeWorktreePathForComparison(approval.worktreePath), approval.lockReason])) } : {}),
        ...(selection.expectedOwners?.length ? { expectedOwners: new Map(selection.expectedOwners.map((owner) =>
          [normalizeWorktreePathForComparison(owner.worktreePath), buildThreadIdentityKey(owner.backend, owner.threadId)])) } : {}) },
      ...options,
    });
    const result = {
      removed: [] as { worktreePath: string }[],
      kept: [] as { worktreePath: string; reason: string; lock?: WorktreeLockedKept }[],
      failed: [] as { worktreePath: string; message: string }[],
      emptyFoldersRemoved: 0,
      emptyFoldersFailed: [] as { worktreePath: string; message: string }[],
    };
    const seen = new Set<string>();
    for (const item of report.cleanup) {
      if (!item.worktreePath) continue;
      const key = normalizeWorktreePathForComparison(item.worktreePath);
      if (!selected.has(key)) continue;
      seen.add(key);
      if (item.removedWorktree) result.removed.push({ worktreePath: item.worktreePath });
      else if (item.error) result.failed.push({ worktreePath: item.worktreePath, message: item.error });
      else result.kept.push({ worktreePath: item.worktreePath, reason: item.skippedReason ?? "Kept",
        ...(item.kept ? { lock: item.kept } : {}) });
    }
    for (const detail of report.protectedWorktreeDetails) {
      const key = normalizeWorktreePathForComparison(detail.worktreePath);
      if (!selected.has(key) || seen.has(key)) continue;
      seen.add(key);
      result.kept.push({ worktreePath: detail.worktreePath,
        reason: detail.externallyManaged ? "Externally managed" : "Used by an active thread" });
    }
    for (const key of selected) {
      if (!seen.has(key)) result.kept.push({ worktreePath: key, reason: "No longer an archived checkout" });
    }
    if (selection.emptyFolders) {
      for (const item of report.containerCleanup) {
        if (item.removed) result.emptyFoldersRemoved += 1;
        else if (item.error) result.emptyFoldersFailed.push({ worktreePath: item.worktreePath, message: item.error });
      }
    }
    return result;
  }

  /**
   * The archive notice's Unlock and Remove: checkpoint and remove archived
   * threads' worktrees that were kept because someone else locked them, in
   * one pass over the archived checkouts. Each takes the same ownership
   * admission as any archived-checkout removal, and is kept when another
   * archived thread owns it by now. Each lock is cleared only while it still
   * says what the operator saw.
   */
  async removeLockedThreadWorktrees(request: RemoveLockedThreadWorktreesRequest): Promise<RemoveLockedThreadWorktreesResponse> {
    if (request.worktrees.length === 0) return { results: [] };
    const removal = await this.removeArchivedCheckouts({
      worktreePaths: request.worktrees.map((item) => item.worktreePath), emptyFolders: false,
      unlockApprovals: request.worktrees.map((item) => ({ worktreePath: item.worktreePath, lockReason: item.approvedLockReason })),
      expectedOwners: request.worktrees.map((item) => ({ worktreePath: item.worktreePath, backend: item.backend, threadId: item.threadId })),
    });
    const byPath = new Map<string, RemoveLockedThreadWorktreeResponse>();
    for (const item of removal.removed) {
      byPath.set(normalizeWorktreePathForComparison(item.worktreePath), { status: "removed", worktreePath: item.worktreePath });
    }
    for (const item of removal.failed) {
      byPath.set(normalizeWorktreePathForComparison(item.worktreePath),
        { status: "failed", worktreePath: item.worktreePath, message: item.message });
    }
    for (const item of removal.kept) {
      byPath.set(normalizeWorktreePathForComparison(item.worktreePath), { status: "kept", worktreePath: item.worktreePath,
        reason: item.reason, ...(item.lock ? { kept: item.lock } : {}) });
    }
    return { results: request.worktrees.map((item) => byPath.get(normalizeWorktreePathForComparison(item.worktreePath))
      ?? { status: "kept", worktreePath: item.worktreePath, reason: "Kept" }) };
  }

  /** Approve one thread's next archive to snapshot up to `bytes`. Expires on
   * its own so a stale approval never applies to a later archive. */
  approveReviewedSnapshotLimit(backend: AppServerBackendKind, threadId: string, bytes: number): void {
    this.reviewedSnapshotLimits.set(buildThreadIdentityKey(backend, threadId), {
      bytes, expiresAt: Date.now() + REVIEWED_SNAPSHOT_LIMIT_TTL_MS,
    });
  }

  clearReviewedSnapshotLimit(backend: AppServerBackendKind, threadId: string): void {
    this.reviewedSnapshotLimits.delete(buildThreadIdentityKey(backend, threadId));
  }

  private reviewedSnapshotLimitFor(backend: AppServerBackendKind, threadId: string): number | undefined {
    const key = buildThreadIdentityKey(backend, threadId);
    const approval = this.reviewedSnapshotLimits.get(key);
    if (!approval) return undefined;
    if (approval.expiresAt < Date.now()) {
      this.reviewedSnapshotLimits.delete(key);
      return undefined;
    }
    return approval.bytes;
  }

  /** Housekeeping hooks shared with the reviewed Thread maintenance run. */
  getThreadArchivePolicy(): DesktopThreadArchivePolicy {
    return this.readThreadArchivePolicy();
  }

  refreshArchiveCandidate(candidate: ThreadArchiveCandidate): Promise<ThreadArchiveCandidate> {
    return this.refreshAutoArchiveCandidate(candidate);
  }

  isArchiveCandidateBusy(candidate: ThreadArchiveCandidate): boolean {
    return this.autoArchiveCandidateIsBusy(candidate);
  }

  getCheckoutHibernationPolicy(): DesktopCheckoutHibernationPolicy {
    return this.readCheckoutHibernationPolicy();
  }

  /** The sweep's thread-level rules for one candidate, as the review shows
   * them. A pass over many candidates passes one `owners` built from
   * `candidates`; without it, this call indexes `candidates` itself. */
  checkoutHibernationKeepReason(
    candidate: ThreadArchiveCandidate,
    candidates: readonly ThreadArchiveCandidate[],
    policy: DesktopCheckoutHibernationPolicy,
    now: number,
    owners: CheckoutPathOwners = new CheckoutPathOwners(candidates),
  ): { target?: string; keep?: string } {
    const target = hibernationTarget(candidate);
    if ("keep" in target) return { target: primaryThreadWorktree(candidate.thread)?.worktreePath, keep: target.keep };
    return { target: target.worktreePath,
      keep: hibernationKeepReason(candidate, now, policy, this.checkoutHibernationContext(candidate, owners)) };
  }

  /** Hibernate one reviewed checkout, with every check run again first. */
  async hibernateReviewedCheckout(candidate: ThreadArchiveCandidate, policy: DesktopCheckoutHibernationPolicy,
    onStage?: (stage: ThreadMaintenanceRunStage) => void): Promise<boolean | string> {
    const target = hibernationTarget(candidate);
    if ("keep" in target) return target.keep;
    const { source: backend, id: threadId } = candidate.thread;
    let outcome: boolean | string = false;
    onStage?.("waitingForWorker");
    await this.archiveCleanupQueue.enqueue(`hibernate:${buildThreadIdentityKey(backend, threadId)}`, async (context) => {
      context.setWorktreePath?.(target.worktreePath);
      onStage?.("waiting");
      outcome = await context.withWorktree!(target.worktreePath, async () => {
        onStage?.("checking");
        return await this.hibernateIdleCheckout(candidate, policy, { reviewed: true, context, onStage });
      });
      return { backend, threadId, archivedAt: Date.now(), cleanup: [] };
    });
    return outcome;
  }

  private async runArchivedThreadWorktreeRepair(options: {
    dryRun?: boolean;
    includeCheckoutInventory?: boolean;
    select?: { worktreePaths: ReadonlySet<string>; emptyFolders: boolean;
      /** Reviewed approvals to snapshot past the normal limit, by normalized
       * checkout path. Each applies only to that checkout's own removal. */
      snapshotLimits?: ReadonlyMap<string, number>;
      /** The operator's approvals to unlock someone else's lock, by
       * normalized checkout path, with the lock text they saw. */
      lockApprovals?: ReadonlyMap<string, string>;
      /** The archived thread each checkout must still belong to, by
       * normalized checkout path, as a thread identity key. Another owner
       * keeps the checkout. */
      expectedOwners?: ReadonlyMap<string, string> };
    onProgress?: (completed: number, total: number, report?: ArchivedWorktreeRepairReport) => void;
    onDiscoveryProgress?: (progress: MaintenanceDiscoveryProgress) => void;
    onItem?: (item: Pick<ThreadMaintenanceRunItem, "status" | "stage" | "reason" | "detail" | "lockReason"> & { path: string }) => void;
    stopped?: () => boolean;
  } = {}): Promise<ArchivedWorktreeRepairReport> {
    await this.host().subAgentStartupReconciliation;
    if (this.host().isBootstrapModeFn() || this.host().isCodexBootstrapDeferredFn() || !this.context.providers.codex.listArchiveCleanupThreadsPage) {
      throw new Error("Complete archived worktree discovery is unavailable.");
    }
    const assertCurrent = () => {
      if (this.context.lifecycle.closed || this.host().stoppingRunningTurnsForShutdown) throw new ArchiveCleanupCancelledError();
    };
    let inventory!: Awaited<ReturnType<ArchiveCleanupInventory["readPacedArchiveCleanupInventory"]>>;
    let report!: ArchivedWorktreeRepairReport;
    const ownersByPath = new Map<string, { thread: AppServerThreadSummary; worktreePath: string }>();
    // Every archived thread that links each checkout. Several can share one
    // (a parent and its sub-threads); any of them may name it for removal.
    const ownerKeysByPath = new Map<string, Set<string>>();
    const canonicalKeys = new Map<string, string>();
    options.onDiscoveryProgress?.({ detail: "Waiting for checkout ownership audit" });
    await this.archiveCleanupQueue.enqueue(`archive-repair-read:${++this.archiveWorkspaceWriteSequence}`, async (context) => {
      const checkpoint = async () => { await context.checkpoint(); };
      const canonical = canonicalWorktreePaths();
      const rememberOwner = async (value: string, thread: AppServerThreadSummary) => {
        try {
          const key = await canonical(value);
          canonicalKeys.set(normalizeWorktreePathForComparison(value), key);
          // Canonical keys may fold Windows casing or resolve an alias. Keep
          // the supplied path for filesystem/provider calls and result data.
          ownersByPath.set(key, { thread, worktreePath: normalizeWorktreePathForComparison(value) });
          const ownerKeys = ownerKeysByPath.get(key) ?? new Set<string>();
          ownerKeys.add(buildThreadIdentityKey(thread.source, thread.id));
          ownerKeysByPath.set(key, ownerKeys);
        } catch (error) {
          report.cleanup.push({ worktreePath: value, removedWorktree: false, deletedBranch: false,
            error: error instanceof Error ? error.message : String(error) });
        }
      };
      inventory = await this.cleanupInventory.readPacedArchiveCleanupInventory({
        backend: "codex", threadId: "", context,
        ...(options.dryRun ? { identityOnly: true } : {}),
        onDiscoveryProgress: options.onDiscoveryProgress,
      });
      if (options.dryRun) {
        // Identity pages are read at the provider's maximum page size with
        // no per-row Git subprocess. Resolve cwd metadata once per checkout
        // in bounded slices instead of serially enriching thousands of rows.
        const observations = new Map<string, Promise<LinkedDirectorySummary | undefined>>();
        let found = 0;
        for (const rows of [inventory.activeThreads, inventory.archivedThreads]) {
          for (let offset = 0; offset < rows.length; offset += ARCHIVE_CLEANUP_SLICE_SIZE) {
            await checkpoint();
            options.onDiscoveryProgress?.({ detail: "Resolving checkout ownership from Git metadata", found });
            const resolved = await Promise.all(rows.slice(offset, offset + ARCHIVE_CLEANUP_SLICE_SIZE).map(async (thread) =>
              await this.maintenanceThreadWorkspace(thread, inventory.overlaysByThreadKey?.get(buildThreadIdentityKey(thread.source, thread.id)), observations)));
            rows.splice(offset, resolved.length, ...resolved);
            found += resolved.length;
          }
        }
      }
      report = {
        archivedThreads: inventory.archivedThreads.length, discoveredWorktrees: 0,
        missingWorktrees: 0, protectedWorktrees: 0, protectedWorktreeDetails: [], candidates: [], cleanup: [],
        emptyContainerCandidates: [], containerCleanup: [],
      };
      for (const thread of inventory.archivedThreads) {
        // A removed checkout may no longer enrich to a linked directory. Its
        // archived provider cwd still proves association with a managed id.
        if (thread.source !== "codex" && thread.source !== "claude" && !isAcpBackendId(thread.source)) continue;
        try {
          if (thread.projectKey && await this.worktreeContainerService.containerPath(thread.projectKey)) {
            await rememberOwner(thread.projectKey, thread);
          }
        } catch (error) {
          report.cleanup.push({ worktreePath: thread.projectKey!, removedWorktree: false, deletedBranch: false,
            error: error instanceof Error ? error.message : String(error) });
        }
        for (const directory of thread.linkedDirectories) {
          const worktreePath = linkedDirectoryWorktreePath(directory);
          if (worktreePath) await rememberOwner(worktreePath, thread);
        }
      }
      report.discoveredWorktrees = ownersByPath.size;
      const owners = [...ownersByPath];
      const summary = report;
      const containerInspections = new Map<string, Promise<WorktreeContainerCleanup | undefined>>();
      let activeChecks = 0, checked = 0, foundCandidates = 0;
      const progress = (root: string) => options.onDiscoveryProgress?.({
        detail: `Checking archived checkout owners · ${checked}/${owners.length} checked · ${activeChecks} in flight`,
        root, found: foundCandidates,
      });
      const inspectOwner = async ([canonicalKey, { worktreePath, thread }]: typeof owners[number]) => {
        if (!options.dryRun) await checkpoint();
        assertCurrent();
        const report: ArchivedWorktreeRepairReport = { ...summary, missingWorktrees: 0, protectedWorktrees: 0,
          protectedWorktreeDetails: [], candidates: [], cleanup: [], emptyContainerCandidates: [], containerCleanup: [] };
        let checkedContainerPath: string | undefined;
        activeChecks += 1;
        progress(worktreePath);
        // One unreadable checkout records its own error; the rest are still read.
        try {
          try {
            if (!(await stat(worktreePath)).isDirectory()) throw new Error(`Worktree path is not a directory: ${worktreePath}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              report.cleanup.push({ worktreePath, removedWorktree: false, deletedBranch: false,
                error: error instanceof Error ? error.message : String(error) });
              return { report, containerPath: checkedContainerPath };
            }
            report.missingWorktrees += 1;
            const containerPath = thread.source === "codex" ? await this.worktreeContainerService.containerPath(worktreePath) : undefined;
            if (containerPath) {
              checkedContainerPath = containerPath;
              let inspectionPending = containerInspections.get(containerPath);
              if (!inspectionPending) {
                inspectionPending = this.worktreeContainerService.inspect(worktreePath);
                containerInspections.set(containerPath, inspectionPending);
              }
              const inspection = await inspectionPending;
              if (inspection?.identity && !inspection.skippedReason && !inspection.error
                && !this.isWorktreeContainerProtected(containerPath, inventory)) {
                report.emptyContainerCandidates.push({ backend: thread.source, threadId: thread.id, worktreePath, containerIdentity: inspection.identity });
              } else if (inspection?.error) report.containerCleanup.push(inspection);
            }
            return { report, containerPath: checkedContainerPath };
          }
          const acpBlocker = this.archivedAcpWorktreeBlocker(worktreePath, inventory);
          if (acpBlocker) {
            report.protectedWorktrees += 1;
            report.cleanup.push({ worktreePath, removedWorktree: false, deletedBranch: false,
              skippedReason: acpBlocker });
            return { report, containerPath: checkedContainerPath };
          }
          const ownership = await this.readCanonicalArchiveOwnership(inventory, worktreePath);
          if (ownership.external || ownership.users.length) {
            report.protectedWorktrees += 1;
            report.protectedWorktreeDetails.push({ worktreePath, externallyManaged: ownership.external,
              activeThreads: ownership.users.map((owner) => ({ backend: owner.source, threadId: owner.id, projectKey: owner.projectKey })),
            });
            if (!options.dryRun && !ownership.external) {
              const directory = thread.linkedDirectories.find((row) => {
                const value = linkedDirectoryWorktreePath(row);
                return value !== undefined && canonicalKeys.get(normalizeWorktreePathForComparison(value)) === canonicalKey;
              });
              await this.retainDeferredArchiveWorktree({ backend: thread.source, thread, activeThreads: inventory.activeThreads },
                { worktreePath, repositoryPath: directory?.path }, ownership.users.map((owner) => buildThreadIdentityKey(owner.source, owner.id)));
            }
            return { report, containerPath: checkedContainerPath };
          }
          report.candidates.push({ backend: thread.source, threadId: thread.id, worktreePath });
        } catch (error) {
          if (error instanceof ArchiveCleanupCancelledError || this.context.lifecycle.closed || this.host().stoppingRunningTurnsForShutdown) throw error;
          report.cleanup.push({ worktreePath, removedWorktree: false, deletedBranch: false,
            error: error instanceof Error ? error.message : String(error) });
        } finally {
          activeChecks -= 1;
          checked += 1;
          foundCandidates += report.candidates.length;
          progress(worktreePath);
        }
        return { report, containerPath: checkedContainerPath };
      };
      const results = options.dryRun
        ? await mapMaintenanceAudit(owners, context, inspectOwner)
        : await (async () => {
            const rows: Awaited<ReturnType<typeof inspectOwner>>[] = [];
            for (const owner of owners) rows.push(await inspectOwner(owner));
            return rows;
          })();
      const seenContainers = new Set<string>();
      for (const { report: row, containerPath } of results) {
        report.missingWorktrees += row.missingWorktrees;
        report.protectedWorktrees += row.protectedWorktrees;
        report.protectedWorktreeDetails.push(...row.protectedWorktreeDetails);
        report.candidates.push(...row.candidates);
        report.cleanup.push(...row.cleanup);
        if (!containerPath || !seenContainers.has(containerPath)) {
          if (containerPath) seenContainers.add(containerPath);
          report.emptyContainerCandidates.push(...row.emptyContainerCandidates);
          report.containerCleanup.push(...row.containerCleanup);
        }
      }
      if (options.dryRun && options.includeCheckoutInventory) {
        await checkpoint();
        await this.describeMaintenanceCheckoutInventory(inventory, report, options.onDiscoveryProgress);
      }
      backendRegistryLog.info("archived worktree repair discovered", {
        archivedThreads: report.archivedThreads, discoveredWorktrees: report.discoveredWorktrees,
        candidates: report.candidates.length, protected: report.protectedWorktrees, missing: report.missingWorktrees,
        dryRun: options.dryRun === true,
      });
      return { backend: "codex", threadId: "", archivedAt: Date.now(), cleanup: [] };
    });
    if (options.dryRun) return report;
    if (options.select) {
      const { worktreePaths, emptyFolders } = options.select;
      report.candidates = report.candidates.filter((candidate) =>
        worktreePaths.has(normalizeWorktreePathForComparison(candidate.worktreePath)));
      if (!emptyFolders) report.emptyContainerCandidates = [];
    }
    const total = report.candidates.length + report.emptyContainerCandidates.length;
    options.onProgress?.(0, total, report);
    let completed = 0;
    await runMaintenanceItems(report.candidates, async (candidate) => {
      assertCurrent();
      if (options.stopped?.()) {
        report.cleanup.push({ worktreePath: candidate.worktreePath, removedWorktree: false, deletedBranch: false, skippedReason: "Stopped before removing" });
        options.onItem?.({ path: candidate.worktreePath, status: "kept", reason: "Stopped before removing" });
        options.onProgress?.(++completed, total, report);
        return;
      }
      const key = buildThreadIdentityKey(candidate.backend, candidate.threadId);
      const expectedOwner = options.select?.expectedOwners?.get(normalizeWorktreePathForComparison(candidate.worktreePath));
      const candidateOwners = ownerKeysByPath.get(canonicalKeys.get(normalizeWorktreePathForComparison(candidate.worktreePath)) ?? "");
      if (expectedOwner !== undefined && !candidateOwners?.has(expectedOwner)) {
        report.cleanup.push({ worktreePath: candidate.worktreePath, removedWorktree: false, deletedBranch: false,
          worktreeState: "present", skippedReason: ARCHIVED_OWNER_CHANGED_REASON });
        options.onItem?.({ path: candidate.worktreePath, status: "kept", reason: ARCHIVED_OWNER_CHANGED_REASON });
        options.onProgress?.(++completed, total, report);
        return;
      }
      options.onItem?.({ path: candidate.worktreePath, status: "running", stage: "waiting" });
      const completion = this.enqueueArchiveRepair(key, candidate.worktreePath, async (context) => {
        options.onItem?.({ path: candidate.worktreePath, status: "running", stage: "checking" });
        // This complete inventory is preliminary only. archiveThreadWorktrees
        // still performs a fresh authoritative ownership scan before removal.
        const candidateKey = canonicalKeys.get(normalizeWorktreePathForComparison(candidate.worktreePath))!;
        const owner = ownersByPath.get(candidateKey)!.thread;
        const thread = { ...owner, linkedDirectories: owner.linkedDirectories.filter((directory) => {
          const worktreePath = linkedDirectoryWorktreePath(directory);
          return worktreePath !== undefined && canonicalKeys.get(normalizeWorktreePathForComparison(worktreePath)) === candidateKey;
        }) };
        if (thread.linkedDirectories.length === 0) throw new Error("Archived thread no longer owns the repair candidate; the worktree was kept.");
        // The operator reviewed this checkout's size. The approval is passed
        // with this one removal, never stored on the thread: another checkout
        // of the same thread may be removed concurrently.
        const snapshotLimit = options.select?.snapshotLimits?.get(normalizeWorktreePathForComparison(candidate.worktreePath));
        const approvedLockReason = options.select?.lockApprovals?.get(normalizeWorktreePathForComparison(candidate.worktreePath));
        return {
          backend: candidate.backend, threadId: candidate.threadId, archivedAt: Date.now(),
          cleanup: await this.archiveThreadWorktrees({
            ...inventory, backend: candidate.backend, thread, context,
            ...(snapshotLimit !== undefined ? { snapshotLimitBytes: snapshotLimit } : {}),
            ...(approvedLockReason !== undefined ? { approvedLockReason } : {}),
            onStage: (stage) => options.onItem?.({ path: candidate.worktreePath, status: "running", stage }),
          }),
        };
      });
      try {
        const result = await this.observeArchiveCleanupCompletion(completion, {
          backend: candidate.backend, threadId: candidate.threadId, archivedAt: Date.now(),
        });
        report.cleanup.push(...result.cleanup);
        for (const item of result.cleanup) {
          if (!item.worktreePath) continue;
          options.onItem?.({ path: item.worktreePath, status: item.removedWorktree ? "done" : item.error ? "failed" : "kept",
            reason: item.error ? "Removal failed" : item.skippedReason, detail: item.error,
            ...(item.kept ? { lockReason: item.kept.lockReason } : {}) });
        }
      } catch (error) {
        assertCurrent();
        report.cleanup.push({ worktreePath: candidate.worktreePath, removedWorktree: false, deletedBranch: false,
          error: error instanceof Error ? error.message : String(error) });
        options.onItem?.({ path: candidate.worktreePath, status: "failed", reason: "Removal failed", detail: error instanceof Error ? error.message : String(error) });
      }
      options.onProgress?.(++completed, total, report);
    });
    for (const candidate of report.emptyContainerCandidates) {
      assertCurrent();
      if (options.stopped?.()) break;
      const key = buildThreadIdentityKey(candidate.backend, candidate.threadId);
      const completion = this.enqueueArchiveRepair(key, candidate.worktreePath, async (context) => {
        const containerPath = await this.worktreeContainerService.containerPath(candidate.worktreePath);
        if (!containerPath) throw new Error("Selected worktree root is unavailable; the container was kept.");
        context.setWorktreePath?.(candidate.worktreePath);
        const prune = async () => {
          const admission = { ...candidate, containerPath };
          const scope = new ArchiveWorkspaceAdmission(key, containerPath);
          const scopedAdmission = { ...admission, scope };
          this.archiveWorktreeRemovalAdmissions.add(scopedAdmission);
          this.archiveWorkspaceOwnership.beginAdmission(scope);
          try {
            const current = await this.cleanupInventory.findThreadForArchiveCleanup({ ...candidate, context, ownershipScope: containerPath, removalAdmission: scope });
            await scope.prepare(this.archiveWorkspaceMutationsFor(scope));
            scope.reserve(this.archiveWorkspaceMutations());
            const ownedPaths = [current.thread.projectKey, ...current.thread.linkedDirectories.map(linkedDirectoryWorktreePath)];
            const canonical = canonicalWorktreePaths();
            const candidateKey = await canonical(candidate.worktreePath);
            const ownedKeys = await Promise.all(ownedPaths.filter((value): value is string => Boolean(value)).map(canonical));
            if (!ownedKeys.includes(candidateKey)) {
              throw new Error("Archived thread no longer owns the container; it was kept.");
            }
            if (this.isWorktreeContainerProtected(containerPath, current)) {
              report.containerCleanup.push({ ...candidate, containerPath, removed: false, skippedReason: "Container has an active or external owner." });
            } else {
              const result = await this.worktreeContainerService.prune(candidate.worktreePath, () => {
                context.assertCurrent();
                scope.assertCurrent(this.archiveWorkspaceMutations());
              }, candidate.containerIdentity);
              if (result) report.containerCleanup.push(result);
            }
            return { backend: candidate.backend, threadId: candidate.threadId, archivedAt: Date.now(), cleanup: [] };
          } finally {
            this.archiveWorktreeRemovalAdmissions.delete(scopedAdmission);
          }
        };
        return context.withWorktree ? await context.withWorktree(containerPath, prune) : await prune();
      });
      try {
        await this.observeArchiveCleanupCompletion(completion, { ...candidate, archivedAt: Date.now() });
      } catch (error) {
        assertCurrent();
        report.containerCleanup.push({ worktreePath: candidate.worktreePath,
          containerPath: path.dirname(candidate.worktreePath), removed: false,
          error: error instanceof Error ? error.message : String(error) });
      }
      options.onProgress?.(++completed, total, report);
    }
    assertCurrent();
    backendRegistryLog.info("archived worktree repair completed", {
      candidates: report.candidates.length, removed: report.cleanup.filter((item) => item.removedWorktree).length,
      failed: [...report.cleanup, ...report.containerCleanup].filter((item) => item.error).length,
      protected: report.protectedWorktrees, removedContainers: report.containerCleanup.filter((item) => item.removed).length,
    });
    this.tryCheckpointArchiveCleanupsForQuit("reference-change");
    return report;
  }

  private isWorktreeContainerProtected(containerPath: string, inventory: Pick<ArchiveCleanupMetadata, "activeThreads" | "worktreeEvidence">): boolean {
    const within = (value: string) => {
      return this.worktreeContainerService.comparisonPaths(containerPath).some((candidate) => {
        const relative = path.relative(candidate, path.resolve(value));
        return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
      });
    };
    if ([...(inventory.worktreeEvidence?.externalPaths ?? [])].some(within)) return true;
    return inventory.activeThreads.some((thread) =>
      (thread.projectKey && within(thread.projectKey))
      || thread.linkedDirectories.some((directory) => {
        const worktreePath = linkedDirectoryWorktreePath(directory);
        return worktreePath && within(worktreePath);
      }),
    );
  }

  private archivedAcpWorktreeOwners(worktreePath: string, inventory: Pick<ArchiveCleanupMetadata, "worktreeEvidence">): AppServerThreadSummary[] {
    return this.worktreeContainerService.worktreeComparisonPaths(worktreePath).flatMap((value) =>
      (inventory.worktreeEvidence?.archivedByPath.get(normalizeWorktreePathForComparison(value)) ?? [])
        .filter((thread) => isAcpBackendId(thread.source)),
    );
  }

  private archivedAcpWorktreeBlocker(worktreePath: string, inventory: Pick<ArchiveCleanupMetadata, "worktreeEvidence">): string | undefined {
    for (const owner of this.archivedAcpWorktreeOwners(worktreePath, inventory)) {
      if (!isAcpBackendId(owner.source)) continue;
      const reason = this.context.providers.acp.worktreeArchiveBlockedReason(owner.source, owner.id);
      if (reason) return reason;
    }
    return undefined;
  }

  private async findThreadForRestoreWorktrees(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined> {
    return await this.host().listThreads({
      backend: params.backend,
      archived: true,
      callerReason: "thread-restore-worktrees",
    })
      .then((threads) => threads.find((thread) => thread.id === params.threadId))
      .catch((error) => {
        backendRegistryLog.warn("restore thread worktree metadata lookup failed", {
          backend: params.backend,
          threadId: params.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      });
  }

  private async archiveThreadWorktrees(params: {
    onStage?: (stage: ThreadMaintenanceRunStage) => void;
    activeThreads: AppServerThreadSummary[];
    archivedThreads: AppServerThreadSummary[];
    backend: AppServerBackendKind;
    thread: AppServerThreadSummary;
    context?: ArchiveCleanupContext;
    codexRolloutMissing?: boolean;
    worktreeEvidence?: ArchiveCleanupMetadata["worktreeEvidence"];
    deferredWorktrees?: ArchiveCleanupIntent["deferredWorktrees"];
    workspaceRevision?: number;
    ownershipPaths?: ArchiveCleanupMetadata["ownershipPaths"];
    /** A reviewed approval for exactly this call's checkouts. */
    snapshotLimitBytes?: number;
    /** The operator's approval to unlock someone else's lock on exactly this
     * call's checkout, with the lock text they saw. Never from an automatic
     * path or an agent. */
    approvedLockReason?: string;
  }): Promise<ArchiveThreadCleanupResult[]> {
    // Ownership may live on another (even archived) thread using the same
    // checkout. A provider alias without the marker must not authorize removal.
    const externalWorktreePaths = params.worktreeEvidence?.externalPaths ?? new Set(
      [params.thread, ...params.activeThreads, ...params.archivedThreads]
        .flatMap((thread) => thread.linkedDirectories)
        .filter((directory) => directory.worktreeOwnership === "external")
        .map(linkedDirectoryWorktreePath)
        .filter((value): value is string => Boolean(value))
        .map(normalizeWorktreePathForComparison),
    );
    const candidates: WorktreeArchiveCandidate[] =
      params.thread.linkedDirectories.flatMap((directory) => {
        const worktreePath = linkedDirectoryWorktreePath(directory);
        if (!worktreePath?.trim()) {
          return [];
        }

        return [
          {
            repositoryPath: directory.path,
            worktreePath,
          },
        ];
      });
    const uniqueCandidates: WorktreeArchiveCandidate[] = [
      ...new Map(
        candidates.map((candidate) => [
          `${candidate.repositoryPath}:${candidate.worktreePath}`,
          candidate,
        ]),
      ).values(),
    ];

    if (params.deferredWorktrees) {
      const canonical = canonicalWorktreePaths();
      const requested = new Set(await Promise.all(params.deferredWorktrees.map((row) => canonical(row.worktreePath))));
      const selected = await Promise.all(uniqueCandidates.map(async (candidate) => requested.has(await canonical(candidate.worktreePath))));
      for (let index = uniqueCandidates.length - 1; index >= 0; index -= 1) if (!selected[index]) uniqueCandidates.splice(index, 1);
    }

    if (uniqueCandidates.length === 0) {
      backendRegistryLog.debug("archive thread worktree cleanup skipped: no worktree candidates", {
        backend: params.backend,
        threadId: params.thread.id,
        linkedDirectoryCount: params.thread.linkedDirectories.length,
        projectKey: params.thread.projectKey,
        gitBranch: params.thread.observedGitBranch ?? params.thread.gitBranch,
      });
      return [];
    }

    const cleanupCandidate = async (candidate: WorktreeArchiveCandidate): Promise<ArchiveThreadCleanupResult> => {
      let removedSnapshot: WorktreeSnapshotSummary | undefined;
      let removalAdmission: ArchiveWorktreeRemovalAdmission | undefined;
      const prior = params.deferredWorktrees?.find((row) => row.worktreePath === candidate.worktreePath)?.snapshot;
      if (prior && !(await pathExists(candidate.worktreePath))) {
        await this.retainSharedWorktreeSnapshotForArchivedThreads({ archivedThreadId: params.thread.id,
          archivedThreads: params.archivedThreads, ownershipPaths: params.ownershipPaths, backend: params.backend, snapshot: prior,
          worktreePath: candidate.worktreePath, context: params.context });
        await this.archiveWorktreeReferences.fulfilled(candidate.worktreePath);
        return { worktreePath: candidate.worktreePath, removedWorktree: true, deletedBranch: false };
      }
      await params.context?.checkpoint();
      try {
        // Ownership records can outlive the folder. Nothing can be kept or
        // blocked by another thread when the target is already absent.
        if (!(await pathExists(candidate.worktreePath))) throw new MissingArchiveWorktreeError(candidate.worktreePath);
        const acpBlocker = this.archivedAcpWorktreeBlocker(candidate.worktreePath, params);
        if (acpBlocker) {
          return { worktreePath: candidate.worktreePath, removedWorktree: false, deletedBranch: false,
            skippedReason: acpBlocker };
        }
        if (externalWorktreePaths.has(normalizeWorktreePathForComparison(candidate.worktreePath))
          && !await this.isManagedArchiveCheckout(params, candidate.worktreePath)) {
          await this.archiveWorktreeReferences.forget(buildThreadIdentityKey(params.backend, params.thread.id), candidate.worktreePath);
          return {
            worktreePath: candidate.worktreePath,
            removedWorktree: false,
            deletedBranch: false,
            skippedReason: "Externally managed worktree; thread archive leaves this checkout in place.",
          };
        }
        const ownership = await this.readCanonicalArchiveOwnership(params, candidate.worktreePath);
        if (ownership.external) {
          await this.archiveWorktreeReferences.forget(buildThreadIdentityKey(params.backend, params.thread.id), candidate.worktreePath);
          return { worktreePath: candidate.worktreePath, removedWorktree: false, deletedBranch: false,
            skippedReason: "Externally managed worktree; thread archive leaves this checkout in place." };
        }
        const activeUsers = ownership.users.filter((thread) => thread.id !== params.thread.id || thread.source !== params.backend);
        if (activeUsers.length > 0) {
          const blockers = activeUsers.map((thread) => buildThreadIdentityKey(thread.source, thread.id));
          // A retry that finds exactly the threads that held the checkout last
          // time has nothing new to report.
          const priorBlockers = new Set(params.deferredWorktrees?.find((row) =>
            normalizeWorktreePathForComparison(row.worktreePath) === normalizeWorktreePathForComparison(candidate.worktreePath))?.blockers);
          const unchanged = priorBlockers.size > 0 && priorBlockers.size === new Set(blockers).size
            && blockers.every((blocker) => priorBlockers.has(blocker));
          await this.retainDeferredArchiveWorktree(params, candidate, blockers);
          const activeThreadIds = activeUsers.map((thread) => thread.id);
          const skippedReason =
            activeThreadIds.length === 1
              ? `Worktree is still used by another active thread: ${activeThreadIds[0]}.`
              : `Worktree is still used by other active threads: ${activeThreadIds.join(", ")}.`;
          backendRegistryLog.debug("archive thread worktree cleanup skipped: shared worktree", {
            backend: params.backend,
            threadId: params.thread.id,
            activeThreadIds,
            repositoryPath: candidate.repositoryPath,
            worktreePath: candidate.worktreePath,
          });
          return {
            worktreePath: candidate.worktreePath,
            branch: params.thread.observedGitBranch ?? params.thread.gitBranch,
            removedWorktree: false,
            deletedBranch: false,
            skippedReason,
            blockingThreads: activeUsers.map((thread) => ({ backend: thread.source, threadId: thread.id, title: thread.title })),
            ...(unchanged ? { unchanged: true } : {}),
          };
        }

        const preparedAcpOwners = new Set<string>();
        const prepareAcpOwners = async (owners: AppServerThreadSummary[]) => {
          for (const { source, id } of owners) {
            const identity = buildThreadIdentityKey(source, id);
            if (!isAcpBackendId(source) || preparedAcpOwners.has(identity)) continue;
            await this.context.providers.acp.prepareWorktreeArchive(source, id);
            preparedAcpOwners.add(identity);
          }
        };
        await prepareAcpOwners(this.archivedAcpWorktreeOwners(candidate.worktreePath, params));
        let removalMetadata: ArchiveCleanupMetadata | undefined;
        let removalSiblings: AppServerThreadSummary[] | undefined;
        const managedContainerPath = params.backend === "codex" ? await this.worktreeContainerService.containerPath(candidate.worktreePath) : undefined;
        const containerBefore = managedContainerPath ? await this.worktreeContainerService.inspect(candidate.worktreePath) : undefined;
        if (containerBefore?.error) backendRegistryLog.warn("archive worktree container inspection failed", containerBefore);
        const admitRemoval = async (admission: ArchiveWorktreeRemovalAdmission) => {
          const { scope } = admission;
          params.onStage?.("checking");
          this.archiveWorktreeRemovalAdmissions.add(admission);
          this.archiveWorkspaceOwnership.beginAdmission(scope);
          const current = await this.cleanupInventory.findThreadForArchiveCleanup({
            backend: params.backend, threadId: params.thread.id, context: params.context,
            codexRolloutMissing: params.codexRolloutMissing,
            ownershipScope: managedContainerPath ?? candidate.worktreePath,
            removalAdmission: scope,
          });
          removalMetadata = current;
          removalSiblings = await this.archivedWorktreeSiblings({ archivedThreadId: params.thread.id, archivedThreads: current.archivedThreads,
            ownershipPaths: current.ownershipPaths, backend: params.backend, worktreePath: candidate.worktreePath });
          const ownership = await this.readCanonicalArchiveOwnership(current, candidate.worktreePath);
          const key = normalizeWorktreePathForComparison(candidate.worktreePath);
          const hasExternalMarker = () => current.worktreeEvidence?.externalPaths.has(key)
            || (!current.worktreeEvidence && [current.thread, ...current.activeThreads, ...current.archivedThreads].some((thread) =>
              thread.linkedDirectories.some((directory) => directory.worktreeOwnership === "external"
                && normalizeWorktreePathForComparison(linkedDirectoryWorktreePath(directory) ?? "") === key),
            ));
          const managedCheckout = hasExternalMarker() && await this.isManagedArchiveCheckout(current, candidate.worktreePath);
          if (ownership.users.some((owner) => owner.id !== params.thread.id || owner.source !== params.backend)) {
            await this.retainDeferredArchiveWorktree({ ...params, activeThreads: current.activeThreads }, candidate,
              ownership.users.filter((owner) => owner.id !== params.thread.id || owner.source !== params.backend)
                .map((owner) => buildThreadIdentityKey(owner.source, owner.id)));
          }
          await scope.prepare(this.archiveWorkspaceMutationsFor(scope));
          const checkOwnership = () => {
            params.context!.assertCurrent();
            scope.assertCurrent(this.archiveWorkspaceMutations());
            if (!current.thread.linkedDirectories.some((directory) => {
              const worktreePath = linkedDirectoryWorktreePath(directory);
              return worktreePath && normalizeWorktreePathForComparison(worktreePath) === key;
            })) throw new Error("The archived thread no longer owns this worktree; the checkout was kept.");
            if (!managedCheckout && hasExternalMarker()) throw new Error("Externally managed worktree; thread archive leaves this checkout in place.");
            if (ownership.external) throw new Error("Externally managed worktree; the checkout was kept.");
            const users = ownership.users.filter((thread) => thread.id !== params.thread.id || thread.source !== params.backend);
            if (users.length) throw new Error("Worktree is still used by another active thread; the checkout was kept.");
          };
          checkOwnership();
          const acpOwners = this.archivedAcpWorktreeOwners(key, current);
          await prepareAcpOwners(acpOwners);
          const check = () => {
            checkOwnership();
            for (const { source, id } of acpOwners) {
              if (isAcpBackendId(source)) this.context.providers.acp.assertWorktreeArchiveReleased(source, id);
            }
          };
            check();
            scope.reserve(this.archiveWorkspaceMutations());
            return check;
        };
        const usesRemovalAdmission = Boolean(params.context && this.context.providers.codex.listArchiveCleanupThreadsPage);
        let expectedCheckout: CheckoutIdentity | undefined;
        let snapshot: WorktreeSnapshotSummary;
        let admission: ArchiveWorktreeRemovalAdmission;
        for (;;) {
          params.context?.assertCurrent();
          admission = {
            backend: params.backend, threadId: params.thread.id,
            worktreePath: normalizeWorktreePathForComparison(candidate.worktreePath),
            containerPath: managedContainerPath,
            scope: new ArchiveWorkspaceAdmission(buildThreadIdentityKey(params.backend, params.thread.id), managedContainerPath ?? candidate.worktreePath),
          };
          removalAdmission = admission;
          let removalStarted = false;
          try {
            snapshot = await this.host().worktreeArchiveService.archive({
              backend: params.backend,
              threadId: params.thread.id,
              worktreePath: candidate.worktreePath,
              repositoryPath: candidate.repositoryPath,
              onStage: usesRemovalAdmission ? (stage) => {
                if (stage === "removing") removalStarted = true;
                params.onStage?.(stage);
              } : params.onStage,
              maxSnapshotBytes: params.snapshotLimitBytes ?? this.reviewedSnapshotLimitFor(params.backend, params.thread.id),
              ...(params.approvedLockReason !== undefined ? { approvedLockReason: params.approvedLockReason } : {}),
              beforeRemove: usesRemovalAdmission ? () => admitRemoval(admission) : undefined,
              ...(usesRemovalAdmission ? { onCheckoutVerified: (checkout: CheckoutIdentity) => { expectedCheckout ??= checkout; } } : {}),
              ...(expectedCheckout ? { expectedCheckout } : {}),
            });
            break;
          } catch (error) {
            if (!(error instanceof ArchiveRemovalNeedsFreshInventoryError) || removalStarted) throw error;
            // The repository lock may have been held by a sibling checkout.
            // Drop the stale reservation and take a fresh snapshot and scope.
            // Only a newly settled archive can invalidate the next attempt this way.
            this.archiveWorktreeRemovalAdmissions.delete(admission);
            backendRegistryLog.info("archive worktree cleanup refreshing removal admission", {
              backend: params.backend, threadId: params.thread.id, worktreePath: candidate.worktreePath,
            });
          }
        }
        const { scope } = admission;
        removedSnapshot = snapshot;
        params.onStage?.("recording");
        backendRegistryLog.info("archive thread worktree cleanup removed worktree", {
          backend: params.backend,
          threadId: params.thread.id,
          repositoryPath: snapshot.repositoryPath,
          worktreePath: snapshot.worktreePath,
        });
        await this.context.stores.archive.upsertWorktreeSnapshot({
          backend: params.backend,
          threadId: params.thread.id,
          snapshot,
        });
        await this.retainSharedWorktreeSnapshotForArchivedThreads({
          archivedThreadId: params.thread.id,
          archivedThreads: removalMetadata?.archivedThreads ?? params.archivedThreads,
          ownershipPaths: removalMetadata ? removalMetadata.ownershipPaths : params.ownershipPaths,
          siblings: removalSiblings,
          backend: params.backend,
          snapshot,
          worktreePath: candidate.worktreePath,
          context: params.context,
        });

        let worktreeStillExists = false;
        try {
          worktreeStillExists = await pathExists(snapshot.worktreePath);
        } catch (sentinelError) {
          const error =
            sentinelError instanceof Error ? sentinelError.message : String(sentinelError);
          backendRegistryLog.error("archive thread worktree cleanup sentinel failed", {
            backend: params.backend,
            threadId: params.thread.id,
            repositoryPath: snapshot.repositoryPath,
            worktreePath: snapshot.worktreePath,
            error,
          });
          await this.retainDeferredArchiveWorktree(params, candidate, [], snapshot);
          return { worktreePath: snapshot.worktreePath, branch: snapshot.sourceBranch, removedWorktree: false,
            deletedBranch: false, error: `Unable to verify worktree removal: ${error}` };

        }

        if (worktreeStillExists) {
          const error = "Worktree directory still exists after archive cleanup.";
          backendRegistryLog.error("archive thread worktree cleanup left worktree directory", {
            backend: params.backend,
            threadId: params.thread.id,
            repositoryPath: snapshot.repositoryPath,
            worktreePath: snapshot.worktreePath,
            branch: snapshot.sourceBranch,
            snapshotRef: snapshot.snapshotRef,
            snapshotCommit: snapshot.snapshotCommit,
            error,
          });
          await this.retainDeferredArchiveWorktree(params, candidate, [], snapshot);
          return {
            worktreePath: snapshot.worktreePath,
            branch: snapshot.sourceBranch,
            removedWorktree: false,
            deletedBranch: false,
            error,
          };
        }

        await this.archiveWorktreeReferences.fulfilled(candidate.worktreePath);
        const containerPath = params.backend === "codex" ? await this.worktreeContainerService.containerPath(snapshot.worktreePath) : undefined;
        if (containerPath && containerBefore?.identity && !this.isWorktreeContainerProtected(containerPath, removalMetadata ?? params)) {
          const containerAdmission = { ...admission, containerPath };
          this.archiveWorktreeRemovalAdmissions.add(containerAdmission);
          const container = await this.worktreeContainerService.prune(snapshot.worktreePath, () => {
            params.context?.assertCurrent();
            scope.assertCurrent(this.archiveWorkspaceMutations());
          }, containerBefore.identity).finally(() => this.archiveWorktreeRemovalAdmissions.delete(containerAdmission));
          if (container?.error) backendRegistryLog.warn("archive empty worktree container cleanup failed", container);
          else if (container?.removed) backendRegistryLog.info("archive empty worktree container removed", container);
        }

        return {
          worktreePath: snapshot.worktreePath,
          branch: snapshot.sourceBranch,
          removedWorktree: true,
          deletedBranch: false,
        };
      } catch (caughtError) {
        let error = caughtError;
        if (error instanceof MissingArchiveRepositoryError || error instanceof MissingArchiveGitEntryError) {
          // The folder may have disappeared during the Git checks.
          try {
            if (!(await pathExists(candidate.worktreePath))) error = new MissingArchiveWorktreeError(candidate.worktreePath);
          } catch (verificationError) {
            error = verificationError;
          }
        }
        if (error instanceof MissingArchiveWorktreeError) {
          await this.archiveWorktreeReferences.forget(buildThreadIdentityKey(params.backend, params.thread.id), candidate.worktreePath);
          backendRegistryLog.debug("archive thread worktree cleanup skipped: missing worktree", {
            backend: params.backend,
            threadId: params.thread.id,
            repositoryPath: candidate.repositoryPath,
            worktreePath: candidate.worktreePath,
          });
          return {
            worktreePath: candidate.worktreePath,
            branch: params.thread.observedGitBranch ?? params.thread.gitBranch,
            removedWorktree: false,
            deletedBranch: false,
            worktreeState: "absent",
            skippedReason: MISSING_WORKTREE_SKIP_REASON,
          };
        }
        if (error instanceof MissingArchiveRepositoryError) {
          // Without its repository the checkout cannot be snapshotted, so it
          // stays on disk. Only the operator may delete it.
          backendRegistryLog.debug("archive thread worktree cleanup skipped: repository missing", {
            backend: params.backend,
            threadId: params.thread.id,
            repositoryPath: error.repositoryPath,
            worktreePath: candidate.worktreePath,
          });
          return {
            worktreePath: candidate.worktreePath,
            branch: params.thread.observedGitBranch ?? params.thread.gitBranch,
            removedWorktree: false,
            deletedBranch: false,
            worktreeState: "present",
            repositoryPath: error.repositoryPath,
            skippedReason: MISSING_REPOSITORY_SKIP_REASON,
          };
        }
        if (error instanceof MissingArchiveGitEntryError) {
          if (!prior) {
            await this.archiveWorktreeReferences.forget(buildThreadIdentityKey(params.backend, params.thread.id), candidate.worktreePath);
          }
          return {
            worktreePath: candidate.worktreePath,
            branch: params.thread.observedGitBranch ?? params.thread.gitBranch,
            removedWorktree: false,
            deletedBranch: false,
            worktreeState: "present",
            skippedReason: error.message,
          };
        }
        if (error instanceof WorktreeLockedError && !removedSnapshot) {
          // Someone other than PwrAgent locked it to keep it. Retrying never
          // unlocks it, so stop retrying; the operator decides from the
          // archive notice or the maintenance dialog.
          await this.archiveWorktreeReferences.forget(buildThreadIdentityKey(params.backend, params.thread.id), candidate.worktreePath);
          backendRegistryLog.info("archive thread worktree cleanup kept a locked worktree", {
            backend: params.backend,
            threadId: params.thread.id,
            repositoryPath: candidate.repositoryPath,
            worktreePath: candidate.worktreePath,
          });
          return {
            worktreePath: candidate.worktreePath,
            branch: params.thread.observedGitBranch ?? params.thread.gitBranch,
            removedWorktree: false,
            deletedBranch: false,
            worktreeState: "present",
            skippedReason: WORKTREE_LOCKED_SKIP_REASON,
            kept: { reason: "worktree-locked", worktreePath: candidate.worktreePath, lockReason: error.lockReason },
          };
        }
        if (error instanceof SnapshotLimitExceededError && !removedSnapshot) {
          // Nothing changes the checkout's size on its own, so a retry at each
          // launch fails the same way and reports it again. Keep the checkout
          // and stop retrying it.
          await this.archiveWorktreeReferences.forget(buildThreadIdentityKey(params.backend, params.thread.id), candidate.worktreePath);
          backendRegistryLog.warn("archive thread worktree cleanup kept an oversized worktree", {
            backend: params.backend,
            threadId: params.thread.id,
            repositoryPath: candidate.repositoryPath,
            worktreePath: candidate.worktreePath,
            error: error.message,
          });
          return {
            worktreePath: candidate.worktreePath,
            branch: params.thread.observedGitBranch ?? params.thread.gitBranch,
            removedWorktree: false,
            deletedBranch: false,
            skippedReason: `${error.message.replace(/\.$/, "")} and will not be retried.`,
          };
        }
        const changed = removalAdmission?.scope.changedThreadKeys() ?? [];
        if (removedSnapshot || changed.length
          || !this.archiveWorktreeReferences.hasPending(buildThreadIdentityKey(params.backend, params.thread.id), candidate.worktreePath)) {
          await this.retainDeferredArchiveWorktree(params, candidate, changed, removedSnapshot);
        }
        backendRegistryLog.warn("archive thread worktree cleanup failed", {
          backend: params.backend,
          threadId: params.thread.id,
          repositoryPath: candidate.repositoryPath,
          worktreePath: candidate.worktreePath,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          worktreePath: candidate.worktreePath,
          branch: params.thread.observedGitBranch ?? params.thread.gitBranch,
          removedWorktree: false,
          deletedBranch: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (removalAdmission) this.archiveWorktreeRemovalAdmissions.delete(removalAdmission);
      }
    };
    const results: ArchiveThreadCleanupResult[] = [];
    for (const candidate of uniqueCandidates) {
      params.context?.setWorktreePath?.(candidate.worktreePath);
      const container = params.backend === "codex" ? await this.worktreeContainerService.containerPath(candidate.worktreePath) : undefined;
      const clean = async () => await cleanupCandidate(candidate);
      results.push(params.context?.withWorktree
        ? await params.context.withWorktree(container ?? candidate.worktreePath, clean)
        : await clean());
    }
    return results;
  }

  private async retainDeferredArchiveWorktree(
    params: { backend: AppServerBackendKind; thread: AppServerThreadSummary; activeThreads?: AppServerThreadSummary[]; workspaceRevision?: number },
    candidate: { worktreePath: string; repositoryPath?: string },
    blockers: string[],
    snapshot?: WorktreeSnapshotSummary,
  ): Promise<void> {
    const key = buildThreadIdentityKey(params.backend, params.thread.id);
    const intent = this.pendingArchiveCleanupIntents.get(key) ?? {
      backend: params.backend, threadId: params.thread.id, archivedAt: Date.now(), codexRolloutMissing: false, messagingCleanup: {},
    };
    await this.archiveWorktreeReferences.retain(intent, { ...candidate, blockers, ...(snapshot ? { snapshot } : {}) });
    for (const blocker of blockers) {
      if ((this.archiveReferenceReleaseRevisions.get(blocker) ?? -1) <= (params.workspaceRevision ?? -1)) continue;
      const row = params.activeThreads?.find((thread) => buildThreadIdentityKey(thread.source, thread.id) === blocker);
      const identity = this.archiveReferenceIdentities.get(blocker) ?? (row ? { backend: row.source, threadId: row.id } : undefined);
      if (identity) await this.observeReleasedArchiveReference(identity.backend, identity.threadId);
    }
  }

  prepareArchiveReferenceChanges(backend: AppServerBackendKind, notification: AppServerNotification): Promise<void> | undefined {
    const previous = this.archiveReferenceNotificationWork.get(notification);
    if (previous) return previous;
    // Provider ingress and publication share a notification object. A delayed
    // publication must not cancel cleanup from an archive accepted since ingress.
    if (notification.method === "thread/unarchived" || notification.method === "thread/deleted") {
      this.cancelArchiveCleanups(buildThreadIdentityKey(backend, notification.params.threadId));
    }
    let work: Promise<void> | undefined;
    if (notification.method === "navigation/threadDirectories/updated") {
      const ids = readRecord(notification.params)?.threadIds;
      if (Array.isArray(ids)) work = Promise.all(ids.filter((id): id is string => typeof id === "string")
        .map(async (id) => { await this.observeReleasedArchiveReference(backend, id); })).then(() => {});
    } else if (notification.method === "thread/archived" || notification.method === "thread/deleted") {
      work = this.observeReleasedArchiveReference(backend, notification.params.threadId, true);
    } else if (notification.method === "thread/unarchived") {
      this.tryCheckpointArchiveCleanupsForQuit("reference-change");
      work = this.observeReleasedArchiveReference(backend, notification.params.threadId, false);
    } else if (notification.method === "thread/started") {
      const thread = readRecord(notification.params.thread);
      const id = readNonEmptyString(notification.params.threadId) ?? readNonEmptyString(thread?.id);
      if (id) work = this.observeReleasedArchiveReference(backend, id, false);
    }
    if (work) this.archiveReferenceNotificationWork.set(notification, work);
    return work;
  }

  private dispatchReleasedArchiveCleanups(ready: ArchiveCleanupIntent[]): void {
    if (this.context.lifecycle.closed) return;
    for (const intent of ready) {
      // Ready rows are the durable backlog. Leave them ready until a physical
      // queue slot is available; slot release resumes dispatch without polling.
      if (this.archiveCleanupQueue.availableSlots === 0) break;
      const key = buildThreadIdentityKey(intent.backend, intent.threadId);
      if (this.archiveCleanupQueue.pending(key) || this.archiveCleanupOverflow.has(key)) continue;
      this.archiveWorktreeReferences.scheduled(intent);
      const completion = this.enqueueArchiveCleanup(intent, true);
      void this.observeArchiveCleanupCompletion(completion, { ...intent, backgroundCleanup: true, reporting: "background" });
    }
  }

  private async observeReleasedArchiveReference(backend: AppServerBackendKind, threadId: string, released?: boolean): Promise<void> {
    const key = buildThreadIdentityKey(backend, threadId);
    const generation = this.archiveWorktreeReferences.beginObservation(key);
    if (released !== false) this.archiveReferenceReleaseRevisions.set(key, this.archiveWorkspaceRevision);
    this.archiveReferenceIdentities.set(key, { backend, threadId });
    if (released === true) this.releasedArchiveReferenceKeys.add(key);
    else if (released === false) this.releasedArchiveReferenceKeys.delete(key);
    if (!this.archiveWorktreeReferences.hasReference(key) || this.context.lifecycle.closed) return;
    try {
      let paths: string[] = [];
      if (!this.releasedArchiveReferenceKeys.has(key)) {
        paths = await this.readArchiveWorkspaceProviderPaths(backend, threadId);
        if (!paths.length) throw new Error("Thread workspace ownership is unknown.");
        const read = this.context.stores.archive.getArchiveCleanupOverlayStates ?? this.context.stores.threads.getThreadOverlayStates;
        const overlays = await read.call(this.context.stores.archive, { backend, threadIds: [threadId] });
        paths.push(...archiveWorkspacePaths({ linkedDirectories: withRetainedWorktrees(overlays[threadId]?.extraLinkedDirectories ?? [], overlays[threadId]) }));
      }
      const ready = await this.archiveWorktreeReferences.observe(key, generation, paths);
      if (!ready.length && !this.archiveCleanupQueue.pendingKeys().length) this.tryCheckpointArchiveCleanupsForQuit("reference-change");
      this.dispatchReleasedArchiveCleanups(ready);
    } catch (error) {
      backendRegistryLog.warn("archive reference reconciliation failed; pending ownership retained", { backend, threadId,
        error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Outside roots, each explicitly external owner must authorize the exact
   * Git checkout. One thread's registration cannot claim another's checkout. */
  private async isManagedArchiveCheckout(
    params: Pick<ArchiveCleanupMetadata, "activeThreads" | "archivedThreads" | "ownershipPaths">,
    worktreePath: string,
  ): Promise<boolean> {
    if (await this.isManagedMaintenanceCheckout(worktreePath)) return true;
    const { external } = await this.canonicalArchiveOwnershipIndex(params);
    if (external.has("*")) return false;
    const checkout = await canonicalWorktreePaths()(worktreePath);
    const owners = external.get(checkout);
    if (!owners?.size) return false;
    const registrations: ThreadWorktreeRegistration[] = [];
    for (const thread of owners) {
      const overlay = await this.context.stores.threads.getThreadOverlayState({ backend: thread.source, threadId: thread.id });
      const registration = overlay?.worktreeRegistrations?.find((entry) => entry.worktreePath === path.resolve(worktreePath));
      if (!registration) return false;
      registrations.push(registration);
    }
    try {
      // All receipts authorize one physical checkout. Compare them with one
      // fresh Git observation, rather than spawning the same probes per owner.
      // This observation belongs only to this admission, never a later scan
      // or the final check before removal.
      const observed = await inspectRegisterableWorktree(worktreePath);
      return registrations.every((registration) => sameRegisteredWorktree(registration, observed));
    } catch {
      return false;
    }
  }

  private canonicalArchiveOwnershipIndex(
    params: Pick<ArchiveCleanupMetadata, "activeThreads" | "archivedThreads" | "ownershipPaths">,
  ) {
    let pending = this.canonicalArchiveOwnership.get(params.activeThreads);
    if (!pending) {
      pending = (async () => {
        const canonical = canonicalWorktreePaths();
        const active = new Map<string, AppServerThreadSummary[]>();
        const unknown: AppServerThreadSummary[] = [];
        const external = new Map<string, Set<AppServerThreadSummary>>();
        // A monitor worker runs in its parent's checkout. Once its every card
        // has ended it no longer uses that checkout, even though the provider
        // still lists it: workers from before they became ephemeral were
        // never archived, and held their parent's checkout forever.
        const finishedWorkers = await this.finishedMonitorWorkerKeys(params.activeThreads);
        for (const thread of params.activeThreads) {
          if (finishedWorkers.has(buildThreadIdentityKey(thread.source, thread.id))) continue;
          const paths = archiveWorkspacePaths(thread);
          if (!paths.length) unknown.push(thread);
          for (const value of params.ownershipPaths?.get(thread) ?? paths) {
            try {
              const key = await canonical(value);
              const users = active.get(key) ?? [];
              if (!users.includes(thread)) users.push(thread);
              active.set(key, users);
            } catch { if (!unknown.includes(thread)) unknown.push(thread); }
          }
        }
        for (const thread of [...params.activeThreads, ...params.archivedThreads]) for (const directory of thread.linkedDirectories) {
          if (directory.worktreeOwnership !== "external") continue;
          const value = linkedDirectoryWorktreePath(directory) ?? directory.path;
          if (params.ownershipPaths?.get(thread) && !params.ownershipPaths.get(thread)!.includes(value)) continue;
          let key: string;
          try { key = await canonical(value); } catch { key = "*"; }
          const owners = external.get(key) ?? new Set<AppServerThreadSummary>();
          owners.add(thread);
          external.set(key, owners);
        }
        return { active, unknown, external };
      })();
      this.canonicalArchiveOwnership.set(params.activeThreads, pending);
    }
    return pending;
  }

  private async readCanonicalArchiveOwnership(
    params: Pick<ArchiveCleanupMetadata, "activeThreads" | "archivedThreads" | "ownershipPaths">,
    worktreePath: string,
  ): Promise<{ users: AppServerThreadSummary[]; external: boolean }> {
    const { active, unknown, external } = await this.canonicalArchiveOwnershipIndex(params);
    const key = await canonicalWorktreePaths()(worktreePath);
    const users = new Set([...active.get(key) ?? [], ...unknown]);
    for (const [value, owners] of active) if (value.startsWith(key + path.sep)) for (const owner of owners) users.add(owner);
    return { users: [...users], external: (external.has(key) || external.has("*"))
      && !await this.isManagedArchiveCheckout(params, worktreePath) };
  }

  /** Archived threads other than the owner that use this checkout. Resolve
   * them before removal: afterwards a sibling's symlink to it dangles and no
   * longer resolves to the checkout. */
  private async archivedWorktreeSiblings(params: {
    archivedThreadId: string;
    archivedThreads: AppServerThreadSummary[];
    ownershipPaths?: ArchiveCleanupMetadata["ownershipPaths"];
    backend: AppServerBackendKind;
    worktreePath: string;
  }): Promise<AppServerThreadSummary[]> {
    const canonical = canonicalWorktreePaths();
    const checkout = await canonical(params.worktreePath);
    const siblingThreads: AppServerThreadSummary[] = [];
    for (const thread of params.archivedThreads) {
      if (thread.source === params.backend && thread.id === params.archivedThreadId) continue;
      for (const value of params.ownershipPaths?.get(thread) ?? archiveWorkspacePaths(thread)) {
        if (await canonical(value).then((candidate) => candidate === checkout).catch(() => false)) {
          siblingThreads.push(thread);
          break;
        }
      }
    }
    return siblingThreads;
  }

  private async retainSharedWorktreeSnapshotForArchivedThreads(params: {
    archivedThreadId: string;
    archivedThreads: AppServerThreadSummary[];
    ownershipPaths?: ArchiveCleanupMetadata["ownershipPaths"];
    /** Resolved while the checkout still existed. */
    siblings?: AppServerThreadSummary[];
    backend: AppServerBackendKind;
    snapshot: WorktreeSnapshotSummary;
    worktreePath: string;
    context?: ArchiveCleanupContext;
  }): Promise<void> {
    const siblingThreads = params.siblings ?? await this.archivedWorktreeSiblings(params);

    if (siblingThreads.length === 0) {
      return;
    }

    for (const thread of siblingThreads) {
      await params.context?.settleCheckpoint();
      await this.context.stores.archive.upsertWorktreeSnapshot({
          backend: thread.source,
          threadId: thread.id,
          snapshot: {
            ...params.snapshot,
            backend: thread.source,
            threadId: thread.id,
          },
      });
    }
  }

  private async ungroupChildrenOfArchivedThread(params: {
    activeThreads: AppServerThreadSummary[];
    backend: AppServerBackendKind;
    parentThreadId: string;
    overlaysByThreadKey?: Map<string, ThreadOverlayState | undefined>;
    context?: ArchiveCleanupContext;
    legacyParentBackends?: Set<AppServerBackendKind>;
  }): Promise<void> {
    const setThreadParent = this.context.stores.threads.setThreadParent;
    if (!setThreadParent) return;
    const legacyParentBackends = params.legacyParentBackends ?? new Set(
      params.activeThreads.filter((thread) => thread.id === params.parentThreadId).map((thread) => thread.source),
    );
    const matches = (backend: AppServerBackendKind, overlay: ThreadOverlayState | undefined) => {
      if (overlay?.parentThreadId !== params.parentThreadId || overlay.parentThreadInstanceId) return false;
      if (overlay.parentThreadBackend) return overlay.parentThreadBackend === params.backend;
      return backend === params.backend || (legacyParentBackends.size === 1 && legacyParentBackends.has(params.backend));
    };
    for (let offset = 0; offset < params.activeThreads.length; offset += ARCHIVE_CLEANUP_SLICE_SIZE) {
      await params.context?.checkpoint();
      for (const thread of params.activeThreads.slice(offset, offset + ARCHIVE_CLEANUP_SLICE_SIZE)) {
        const identity = { backend: thread.source, threadId: thread.id };
        const overlay = params.overlaysByThreadKey
          ? params.overlaysByThreadKey.get(buildThreadIdentityKey(thread.source, thread.id))
          : await this.context.stores.threads.getThreadOverlayState(identity);
        if (!matches(thread.source, overlay)) continue;
        // A queued archive must not remove a relationship changed since its
        // discovery. setThreadParent checks expectedParent in its transaction.
        await params.context?.checkpoint();
        const current = await this.context.stores.threads.getThreadOverlayState(identity);
        if (!matches(thread.source, current)) continue;
        params.context?.assertCurrent();
        await setThreadParent.call(this.context.stores.archive, {
          ...identity, parentThreadId: undefined,
          expectedParent: { threadId: params.parentThreadId,
            backend: current!.parentThreadBackend ?? thread.source,
            instanceId: current!.parentThreadInstanceId },
        });
      }
    }
  }

  private async restoreThreadWorktrees(params: {
    backend: AppServerBackendKind;
    threadId: string;
    thread?: AppServerThreadSummary;
  }): Promise<RestoreThreadWorktreeResult[]> {
    const overlay = await this.context.stores.threads.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    const candidates = await this.buildRestoreThreadWorktreeCandidates({
      backend: params.backend,
      overlay,
      thread: params.thread,
    });

    return await Promise.all(
      candidates.map(
        async (candidate): Promise<RestoreThreadWorktreeResult> => {
          try {
            if (await pathExists(candidate.worktreePath)) {
              // A hibernated checkout is the archived case without a thread
              // archive: another thread may have restored the same path.
              if (candidate.snapshot?.state === "archived" || candidate.snapshot?.state === "hibernated") {
                const sharedRestore = await this.findSharedWorktreeRestore(candidate.snapshot);
                if (sharedRestore) {
                  await this.context.stores.archive.upsertWorktreeSnapshot({ backend: params.backend, threadId: params.threadId,
                    snapshot: { ...candidate.snapshot, state: "restored", restoredAt: sharedRestore.restoredAt,
                      restoredCheckoutIdentity: sharedRestore.restoredCheckoutIdentity } });
                } else if (params.backend === "claude" || isAcpBackendId(params.backend)) {
                  throw new Error("An unexpected or incomplete checkout already exists at the archived worktree path; it was kept without modification.");
                }
              }
              if (isAcpBackendId(params.backend) && candidate.snapshot?.state === "restored"
                && !await this.host().worktreeArchiveService.isRestoredCheckout(candidate.snapshot)) {
                throw new Error("The restored ACP checkout was replaced; it was kept without modification.");
              }
              return {
                worktreePath: candidate.worktreePath,
                repositoryPath: candidate.repositoryPath,
                snapshotRef: candidate.snapshot?.snapshotRef,
                restored: false,
                skippedReason: "Worktree path already exists.",
              };
            }

            if (!candidate.repositoryPath) {
              return {
                worktreePath: candidate.worktreePath,
                snapshotRef: candidate.snapshot?.snapshotRef,
                restored: false,
                skippedReason:
                  "Repository path is unavailable for this archived worktree.",
              };
            }

            if (isAcpBackendId(params.backend) && !candidate.snapshot) {
              throw new Error("No recovery snapshot is available for the missing ACP checkout.");
            }
            const repositoryPath = candidate.repositoryPath;
            const snapshot = candidate.snapshot;
            const restoredSnapshot = snapshot
              ? await this.withArchiveWorkspaceWrite([candidate.worktreePath], async () => await this.host().worktreeArchiveService.restore({
                  backend: params.backend,
                  threadId: params.threadId,
                  worktreePath: candidate.worktreePath,
                  repositoryPath,
                  snapshotRef: snapshot.snapshotRef,
                  snapshotCommit: snapshot.snapshotCommit,
                  snapshot,
                  allowDetachedFallback: params.backend !== "claude" && !isAcpBackendId(params.backend),
                  // Every checkout goes back on its own branch with its saved
                  // edits as working-tree changes. A branch now checked out
                  // elsewhere, moved or deleted gets the saved HEAD detached.
                  restoreSourceCheckout: true,
                }))
              : await this.withArchiveWorkspaceWrite([candidate.worktreePath], async () => await this.host().worktreeArchiveService.restoreDetached({
                  backend: params.backend,
                  threadId: params.threadId,
                  worktreePath: candidate.worktreePath,
                  repositoryPath,
                  restoreRef: candidate.branch,
                }));
            await this.context.stores.archive.upsertWorktreeSnapshot({
              backend: params.backend,
              threadId: params.threadId,
              snapshot: restoredSnapshot,
            });

            return {
              worktreePath: restoredSnapshot.worktreePath,
              repositoryPath: restoredSnapshot.repositoryPath,
              snapshotRef: restoredSnapshot.snapshotRef,
              restored: true,
              snapshot: restoredSnapshot,
            };
          } catch (error) {
            backendRegistryLog.warn("restore thread worktree restore failed", {
              backend: params.backend,
              threadId: params.threadId,
              repositoryPath: candidate.repositoryPath,
              worktreePath: candidate.worktreePath,
              snapshotRef: candidate.snapshot?.snapshotRef,
              error: error instanceof Error ? error.message : String(error),
            });
            return {
              worktreePath: candidate.worktreePath,
              repositoryPath: candidate.repositoryPath,
              snapshotRef: candidate.snapshot?.snapshotRef,
              restored: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      ),
    );
  }

  private async findSharedWorktreeRestore(snapshot: WorktreeSnapshotSummary): Promise<WorktreeSnapshotSummary | undefined> {
    const owners = await this.context.stores.archive.listThreadArchiveStates?.() ?? [];
    for (const owner of owners) {
      if (owner.backend === snapshot.backend && owner.threadId === snapshot.threadId) continue;
      const restored = owner.worktreeSnapshots?.find((candidate) => candidate.state === "restored"
        && candidate.snapshotRef === snapshot.snapshotRef && candidate.snapshotCommit === snapshot.snapshotCommit
        && candidate.archivedAt === snapshot.archivedAt
        && normalizeWorktreePathForComparison(candidate.worktreePath) === normalizeWorktreePathForComparison(snapshot.worktreePath));
      if (restored && await this.host().worktreeArchiveService.isRestoredCheckout(restored)) return restored;
    }
    return undefined;
  }

  private async buildRestoreThreadWorktreeCandidates(params: {
    backend: AppServerBackendKind;
    overlay?: ThreadOverlayState;
    thread?: AppServerThreadSummary;
  }): Promise<WorktreeRestoreCandidate[]> {
    const snapshotCandidates: WorktreeRestoreCandidate[] = [
      ...(params.overlay?.worktreeSnapshots ?? []),
    ]
      .filter((snapshot) => snapshot.state !== "present")
      .sort(
        (left, right) =>
          (right.archivedAt ?? right.restoredAt ?? right.createdAt) -
          (left.archivedAt ?? left.restoredAt ?? left.createdAt),
      )
      .map((snapshot) => ({
        repositoryPath: snapshot.repositoryPath,
        snapshot,
        worktreePath: snapshot.worktreePath,
      }));
    const metadataCandidates = this.buildRestoreThreadMetadataCandidates(
      params.thread,
      snapshotCandidates,
    );
    const seenWorktreePaths = new Set<string>();
    const candidates: WorktreeRestoreCandidate[] = [];
    for (const candidate of [...snapshotCandidates, ...metadataCandidates]) {
      const container = params.backend === "codex" ? await this.worktreeContainerService.containerPath(candidate.worktreePath) : undefined;
      const resolvedPath = container ? path.join(container, path.basename(candidate.worktreePath)) : path.resolve(candidate.worktreePath);
      // The snapshot uses Git's canonical path while provider metadata can
      // retain the home alias. Restore that physical checkout only once,
      // preferring its snapshot over a metadata-only detached fallback.
      if (seenWorktreePaths.has(resolvedPath)) continue;
      seenWorktreePaths.add(resolvedPath);
      candidates.push(container ? { ...candidate, worktreePath: resolvedPath } : candidate);
    }
    return candidates;
  }

  private buildRestoreThreadMetadataCandidates(
    thread: AppServerThreadSummary | undefined,
    snapshotCandidates: WorktreeRestoreCandidate[],
  ): WorktreeRestoreCandidate[] {
    if (!thread) {
      return [];
    }

    const fallbackRepositoryPath = snapshotCandidates.find(
      (candidate) => candidate.repositoryPath?.trim(),
    )?.repositoryPath;
    const branch = thread.observedGitBranch ?? thread.gitBranch;

    return thread.linkedDirectories.flatMap((directory): WorktreeRestoreCandidate[] => {
      const worktreePath =
        directory.worktreePath ?? (directory.kind === "worktree" ? directory.path : undefined);
      if (!worktreePath?.trim()) {
        return [];
      }

      const repositoryPath =
        directory.path.trim() &&
        !isToolManagedWorktreePath(directory.path) &&
        path.resolve(directory.path) !== path.resolve(worktreePath)
          ? directory.path
          : fallbackRepositoryPath;

      return [
        {
          branch,
          repositoryPath,
          worktreePath,
        },
      ];
    });
  }

  private async restoreWithClient(
    client: BackendClient,
    threadId: string,
  ): Promise<{ threadId: string }> {
    if (!client.restoreThread) {
      throw new Error("Selected backend does not support thread restore");
    }

    return await client.restoreThread({ threadId });
  }

  /**
   * Resolves once archive cleanup is parked on its pacing checkpoint, the one
   * timer the cleanup path owns. A fake-clock test advances time exactly then
   * and otherwise awaits the cleanup itself. Slicing the clock on a budget
   * instead raced the host I/O that runs between checkpoints, which fake
   * timers cannot complete (#2665).
   */
  whenArchiveCleanupCheckpointPendingForTests(): Promise<void> {
    return this.archiveCleanupQueue.whenCheckpointPending();
  }

  observeActiveThreadWorkspace(thread: AppServerThreadSummary, enriched: boolean): void {
    const key = buildThreadIdentityKey(thread.source, thread.id);
    const previous = this.observedActiveThreadWorkspaces.get(key);
    const projectKey = thread.projectKey ? normalizeWorktreePathForComparison(thread.projectKey) : "";
    // Unenriched rows can omit linked directories. Keep the last observed
    // ownership evidence in that case so display refreshes do not look like
    // workspace changes. An enriched row or explicit directories replaces it.
    const linkedWorktrees = !enriched && thread.linkedDirectories.length === 0
      ? previous?.linkedWorktrees ?? new Set<string>()
      : new Set(thread.linkedDirectories.flatMap((directory) => {
        const worktreePath = linkedDirectoryWorktreePath(directory);
        return worktreePath === undefined ? [] : [JSON.stringify([
          normalizeWorktreePathForComparison(worktreePath),
          directory.worktreeOwnership === "external",
        ])];
      }));
    // A navigation observation can reveal an owner missing from the final
    // inventory even when it matches an older row. Record its canonical scope;
    // unrelated observations must not invalidate another checkout's removal.
    this.recordArchiveWorkspaceChange(key, archiveWorkspacePaths(thread), true);
    if (
      !previous
      || previous.projectKey !== projectKey
      || previous.linkedWorktrees.size !== linkedWorktrees.size
      || [...linkedWorktrees].some((worktree) => !previous.linkedWorktrees.has(worktree))
    ) {
      // A refresh can be the first evidence of another client's workspace
      // mutation, even when the active thread IDs are unchanged. Invalidate
      // pending removal admission synchronously before publishing that row.
      this.archiveWorkspaceRevision += 1;
      this.recordArchiveWorkspaceChange(key, archiveWorkspacePaths(thread));
    }
    this.observedActiveThreadWorkspaces.set(key, { projectKey, linkedWorktrees });
  }

  private archiveWorkspaceMutationsFor(scope: ArchiveWorkspaceAdmission, mutations = this.archiveWorkspaceMutations()): ArchiveWorkspaceMutation[] {
    for (const { key } of mutations) this.cleanupInventory.observeArchiveFleetIdentity(scope, key);
    return mutations;
  }

  private archiveWorkspaceMutations(): ArchiveWorkspaceMutation[] {
    return [...this.threadLifecycleMutationCounts.keys()].flatMap((key) =>
      [...this.archiveLifecycleMutationPaths.get(key) ?? [[]]].map((paths) => ({ key, paths })),
    );
  }

  recordArchiveWorkspaceChange(key?: string, paths: readonly string[] = [], observation = false, archiving = false): void {
    const identity = key ? parseThreadIdentityKey(key) : undefined;
    this.cleanupInventory.noteArchiveFleetChange(identity ? { backend: identity.backend, threadId: identity.threadId } : undefined, "provider",
      "workspace change without an identity");
    for (const scope of new Set([...this.archiveWorktreeRemovalAdmissions].map((admission) => admission.scope))) {
      if (observation && key === scope.ownerKey) continue;
      if (key) this.cleanupInventory.observeArchiveFleetIdentity(scope, key);
      const observedPaths = observation && paths.length === 0 ? [""] : paths;
      if (observation && key) scope.observeThread(key, observedPaths);
      scope.changed(key, observedPaths, archiving);
    }
  }

  /** Every directory writer enters here before its first asynchronous read.
   * The final read also runs for failures/rollbacks: a notification may have
   * observed an intermediate overlay, or another writer may still be active. */
  async withThreadWorkspaceMutation<T>(
    identity: { backend: AppServerBackendKind; threadId: string },
    work: () => Promise<T>,
    paths?: readonly string[],
  ): Promise<T> {
    const finish = this.archiveWorkspaceOwnership.beginMutation(buildThreadIdentityKey(identity.backend, identity.threadId), paths !== undefined);
    this.archiveWorkspaceRevision += 1;
    this.cleanupInventory.noteArchiveFleetChange(identity, "provider", "workspace mutation");
    try {
      if (paths) {
        await this.cleanupInventory.notePathWrite(paths);
        await this.archiveWorkspaceOwnership.assertAvailable(paths);
      }
      return await work();
    } finally {
      this.archiveWorkspaceRevision += 1;
      this.cleanupInventory.noteArchiveFleetChange(identity, "provider", "workspace mutation");
      await this.refreshArchiveWorkspaceOwnership(identity.backend, identity.threadId, finish());
    }
  }

  private archiveWorkspaceWriteSequence = 0;

  withArchiveWorkspaceWrite<T>(paths: readonly string[], work: () => Promise<T>): Promise<T> {
    return this.withArchiveWorkspaceWriteKey(paths, () => work());
  }

  async withArchiveWorkspaceWriteKey<T>(paths: readonly string[], work: (key: string) => Promise<T>): Promise<T> {
    const key = `workspace-write:${++this.archiveWorkspaceWriteSequence}`;
    const finish = this.archiveWorkspaceOwnership.beginMutation(key, true);
    try {
      // The written identity is announced after the write. Until a complete
      // read, a removal near these paths cannot rely on incremental evidence.
      await this.cleanupInventory.notePathWrite(paths);
      await this.archiveWorkspaceOwnership.assertAvailable(paths);
      return await work(key);
    } finally {
      await this.archiveWorkspaceOwnership.refresh(finish(), async () => paths.length ? paths : [""]);
    }
  }

  private async readArchiveWorkspaceProviderPaths(backend: AppServerBackendKind, threadId: string): Promise<string[]> {
    let thread: AppServerThreadSummary | undefined;
    if (backend === "codex") {
      if (this.context.providers.codex.readArchiveCleanupThreadSummary) {
        thread = await this.context.providers.codex.readArchiveCleanupThreadSummary(threadId, async () => {});
      } else if (this.context.providers.codex.listArchiveCleanupThreadsPage) {
        for (const archived of [false, true]) {
          const cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = await this.context.providers.codex.listArchiveCleanupThreadsPage({ archived, cursor, limit: 100, checkpoint: async () => {} });
            thread = page.threads.find((row) => row.id === threadId);
            cursor = page.nextCursor;
            if (thread) break;
            if (cursor && cursors.has(cursor)) throw new Error("Workspace observation did not advance.");
            if (cursor) cursors.add(cursor);
          } while (cursor);
          if (thread) break;
        }
      }
    } else if (isAcpBackendId(backend)) {
      const session = this.context.providers.acp.getSession(backend, threadId);
      if (session) thread = this.context.providers.acp.sessionToThreadSummary(session);
    } else if (backend === "claude") {
      for (const archived of [false, true]) {
        thread = (await this.context.providers.claude.listThreads({ archived })).find((row) => row.id === threadId);
        if (thread) break;
      }
    }
    return thread ? archiveWorkspacePaths(thread) : [];
  }

  private async refreshArchiveWorkspaceOwnership(
    backend: AppServerBackendKind,
    threadId: string,
    observation: ArchiveWorkspaceObservation,
    started?: Record<string, unknown>,
  ): Promise<void> {
    await this.archiveWorkspaceOwnership.refresh(observation, async () => {
      const providerPaths = started ? archiveNotificationWorkspacePaths(started)
        : await this.readArchiveWorkspaceProviderPaths(backend, threadId);
      const readOverlays = this.context.stores.archive.getArchiveCleanupOverlayStates ?? this.context.stores.threads.getThreadOverlayStates;
      const overlays = await readOverlays.call(this.context.stores.archive, { backend, threadIds: [threadId] });
      const overlay = overlays[threadId];
      const paths = archiveWorkspacePaths({ linkedDirectories: withRetainedWorktrees(overlay?.extraLinkedDirectories ?? [], overlay) });
      return [...providerPaths, ...paths, ...(providerPaths.length === 0 ? [""] : [])];
    });
  }

  async prepareArchiveWorkspaceChanges(
    backend: AppServerBackendKind,
    notification: AppServerNotification,
    observations: Array<{ threadId: string; observation: ArchiveWorkspaceObservation }>,
  ): Promise<void> {
    const started = notification.method === "thread/started" ? readRecord(notification.params.thread) : undefined;
    await Promise.all(observations.map(async ({ threadId, observation }) => {
      await this.refreshArchiveWorkspaceOwnership(backend, threadId, observation, started);
    }));
    const mutations = this.archiveWorkspaceMutations();
    await Promise.all([...new Set([...this.archiveWorktreeRemovalAdmissions].map((admission) => admission.scope))]
      .map(async (scope) => { await scope.prepare(this.archiveWorkspaceMutationsFor(scope, mutations)); }));
  }

  invalidateArchiveCleanupReads(
    backend?: AppServerBackendKind,
    notification?: AppServerNotification,
    workspaceChanged = true,
    threadId?: string,
    paths: readonly string[] = [],
    change: FleetChange = notification?.method === "thread/archived" ? "archived"
      : notification?.method === "thread/deleted" ? "deleted"
        : notification?.method === "thread/unarchived" ? "active" : "provider",
  ): void {
    // Membership-only refreshes without an identity (navigation observing its
    // own archive) change no checkout user; their added identities are marked
    // through recordArchiveWorkspaceChange.
    if (backend && threadId) this.cleanupInventory.noteArchiveFleetChange({ backend, threadId }, change, "identity change");
    else if (workspaceChanged) this.cleanupInventory.noteArchiveFleetChange(undefined, change, "workspace change without an identity");
    if (workspaceChanged) {
      this.archiveWorkspaceRevision += 1;
      this.recordArchiveWorkspaceChange(backend && threadId ? buildThreadIdentityKey(backend, threadId) : undefined, paths, false, change === "archived");
    }
    this.archiveCleanupReads.invalidate(backend);
    if (!backend || backend === "codex") this.context.providers.codex.invalidateThreadListings?.(notification);
  }

  invalidateArchiveCleanupForNotification(
    backend: AppServerBackendKind,
    notification: AppServerNotification,
    source: "provider" | "local" = "local",
  ): Array<{ threadId: string; observation: ArchiveWorkspaceObservation }> | undefined {
    const observations: Array<{ threadId: string; observation: ArchiveWorkspaceObservation }> = [];
    const invalidateOwnership = (threadId: string, change: FleetChange) => {
      this.cleanupInventory.noteArchiveFleetChange({ backend, threadId }, change, "identity change");
      observations.push({ threadId, observation: this.archiveWorkspaceOwnership.invalidate(buildThreadIdentityKey(backend, threadId),
        source === "local" && this.archiveWorkspaceOwnership.isControlled(buildThreadIdentityKey(backend, threadId)) ? "controlled" : "observed") });
    };
    if (notification.method === "thread/parent/set" || notification.method === "thread/parent/cleared") {
      const threadId = readNonEmptyString(readRecord(notification.params)?.threadId);
      this.cleanupInventory.noteArchiveFleetChange(threadId ? { backend, threadId } : undefined, "overlay", "grouping change without an identity");
    }
    const membershipChanged = notification.method === "thread/archived"
      || notification.method === "thread/deleted"
      || notification.method === "thread/unarchived"
      || notification.method === "account/updated";
    if (
      (membershipChanged
        || notification.method === "thread/started"
        || notification.method === "thread/rewound"
        || notification.method === "turn/started"
        || notification.method === "navigation/threadDirectories/updated"
        // Idle/notLoaded cannot add a checkout user. Active or uncertain
        // status can reactivate a review helper excluded by the safety inventory.
        || (notification.method === "thread/status/changed"
          && !["idle", "notLoaded"].includes(readStatusType(notification.params.status) ?? "")))
      && !this.archiveCleanupNotifications.has(notification)
    ) {
      // Provider notifications enter before async cleanup, then reach emit.
      // One notification must advance the archive generation only once.
      this.archiveCleanupNotifications.add(notification);
      if (notification.method === "thread/archived" || notification.method === "thread/deleted") {
        this.host().pendingStartedThreads.delete(buildThreadIdentityKey(backend, notification.params.threadId));
      }
      // The successful local archive already fenced this mutation. A delayed
      // matching notification refreshes archive membership, but must not fail
      // the same cleanup's removal admission as a second workspace change.
      if (membershipChanged) {
        this.invalidateArchiveCleanupReads(backend, notification, !this.isAcknowledgedArchiveCleanupNotification(backend, notification),
          "threadId" in notification.params ? notification.params.threadId : undefined);
      } else {
        // A new checkout user invalidates removal admission, but does not
        // change archived membership or require another messaging cleanup scan.
        this.archiveWorkspaceRevision += 1;
        if (notification.method === "thread/started") {
          const thread = readRecord(notification.params.thread);
          const threadId = readNonEmptyString(notification.params.threadId) ?? readNonEmptyString(thread?.id);
          if (threadId) invalidateOwnership(threadId, "provider");
          else this.recordArchiveWorkspaceChange();
        } else if (notification.method === "navigation/threadDirectories/updated") {
          const threadIds = notification.params.threadIds;
          const identities = Array.isArray(threadIds) ? threadIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
          if (Array.isArray(threadIds) && identities.length && identities.length === threadIds.length) {
            // A directory refresh can report a provider cwd move as well as an
            // overlay link, so the identity's provider row is read again too.
            for (const threadId of new Set(identities)) invalidateOwnership(threadId, "provider");
          } else this.recordArchiveWorkspaceChange();
        } else {
          const threadId = readNonEmptyString(readRecord(notification.params)?.threadId);
          this.recordArchiveWorkspaceChange(threadId ? buildThreadIdentityKey(backend, threadId) : undefined);
        }
      }
      return observations;
    }
    return undefined;
  }

  private isAcknowledgedArchiveCleanupNotification(backend: AppServerBackendKind, notification: AppServerNotification): boolean {
    return notification.method === "thread/archived"
      && this.archiveCleanupCompletions.has(buildThreadIdentityKey(backend, notification.params.threadId));
  }
}
