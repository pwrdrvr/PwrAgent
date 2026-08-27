import { BrowserWindow, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DirectoryGitStatusCacheEntry,
  OverlayStoreLike,
  PrLookupCacheEntry,
  PrStatusCacheEntry,
  SqliteOverlayStore,
  WorktreeGitWorkingStateCacheEntry,
} from "../state/overlay-store-sqlite";
import {
  sanitizeRendererPayload,
  type AgentEvent,
  type AppServerBackendKind,
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
  type AttachDirectoryToThreadRequest,
  type AttachDirectoryToThreadResponse,
  type DetachDirectoryFromThreadRequest,
  type DetachDirectoryFromThreadResponse,
  type CheckThreadPullRequestStatusToolArgs,
  type WatchThreadPullRequestToolArgs,
  type ThreadPullRequestAutomationStatus,
  type ThreadPullRequestWatchEvent,
  type ThreadPullRequestWatchSummary,
  type CancelThreadPrAutoDispatchRequest,
  type SendThreadPrAutoDispatchNowRequest,
  type SetThreadPrAutoDispatchRequest,
  type SetEligibleThreadsPrAutoDispatchRequest,
  type SetEligibleThreadsPrAutoDispatchResponse,
  type ThreadSearchRequest,
  type ThreadSearchResponse,
  type PersistThreadUsageActivityRequest,
  type PersistThreadUsageActivityResponse,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type AnalyzeThreadToolHistoryRequest,
  type AnalyzeThreadToolHistoryResponse,
  type GetThreadFileDiffRequest,
  type GetThreadFileDiffResponse,
  type EnsureDirectoryLaunchpadRequest,
  type EnsureDirectoryLaunchpadResponse,
  type FocusedDiffAnalysisRequest,
  type FocusedDiffAnalysisResponse,
  type GetNavigationSnapshotRequest,
  type GetNavigationSnapshotTransportRequest,
  type HandoffThreadWorkspaceRequest,
  type HandoffThreadWorkspaceResponse,
  type GetGhStatusRequest,
  type GhStatus,
  type LinkedDirectorySummary,
  type ListModelSettingsRecentsRequest,
  type ListModelSettingsRecentsResponse,
  type ListRecentFileReferencesRequest,
  type ListRecentFileReferencesResponse,
  type RecordModelSettingsRecentRequest,
  type PickDirectoryFromDiskResponse,
  type PickFileFromDiskResponse,
  type PickReferenceFromDiskResponse,
  type InspectPdfReferencePathsRequest,
  type InspectPdfReferencePathsResponse,
  type RenderComposerPdfPreviewRequest,
  type RenderComposerPdfPreviewResponse,
  type RecordRecentFileReferencesRequest,
  type DetachThreadPullRequestRequest,
  type DetachThreadPullRequestResponse,
  type DesktopSettingsSnapshot,
  type RefreshDirectoryGitStatusesRequest,
  type RefreshDirectoryGitStatusesResponse,
  type RefreshThreadGitWorkingStateRequest,
  type RefreshThreadGitWorkingStateResponse,
  type RefreshThreadPullRequestsRequest,
  type SetPullRequestPollingFocusRequest,
  type RefreshThreadPullRequestsResponse,
  type RegisterDirectoryFromDiskRequest,
  type RegisterDirectoryFromDiskResponse,
  type MarkThreadSeenRequest,
  type MarkThreadSeenResponse,
  type NavigationDirectorySummary,
  type NavigationDirectoryGitStatus,
  type NavigationDirectoryGitStatusUpdatedNotification,
  type NavigationThreadGitWorkingStateUpdatedNotification,
  type NavigationSnapshot,
  type NavigationSnapshotTransportResponse,
  type NavigationThreadSummary,
  type AutomationThreadSummary,
  type PrSummary,
  type PrAutoDispatchBudgetConfig,
  type PrAutoDispatchBudgetStatus,
  type AddRemoteThreadPinRequest,
  type AddRemoteThreadPinResponse,
  type FederatedThreadRef,
  type FederationJumpSearchRequest,
  type FederationJumpSearchResponse,
  type RemoveRemoteThreadPinRequest,
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
  type SetThreadAgentResponse,
  type SetThreadPinRequest,
  type SetThreadPinResponse,
  type SetThreadReactionRequest,
  type SetThreadReactionResponse,
  type SetThreadToolIncidentNoticeRequest,
  type SetThreadToolIncidentNoticeResponse,
  type AcknowledgeThreadSpendAlertRequest,
  type AcknowledgeThreadSpendAlertResponse,
  type SetNavigationBrowseModeRequest,
  type SetNavigationBrowseModeResponse,
  type ListThreadMigrationSourceThreadsRequest,
  type ListThreadMigrationSourceThreadsResponse,
  type ListThreadMigrationSourcesResponse,
  type RetryThreadMigrationRequest,
  type StartThreadMigrationRequest,
  type StartThreadMigrationResponse,
  type ResetDirectoryLaunchpadRequest,
  type ResetDirectoryLaunchpadResponse,
  type RenameThreadRequest,
  type RenameThreadResponse,
  type RestoreWorktreeRequest,
  type RestoreWorktreeResponse,
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
  type ResolveMissingCodexThreadsRequest,
  type ResolveMissingCodexThreadsResponse,
  type RestoreThreadRequest,
  type RestoreThreadResponse,
  type ThreadGitWorkingState,
  type ThreadOverlayState,
  type ThreadPrAutoDispatchPending,
  type UpdateDirectoryLaunchpadRequest,
  type UpdateDirectoryLaunchpadResponse,
  type UpdateSubthreadOrderRequest,
  type UpdateSubthreadOrderResponse,
  type PwrAgentThreadInspectionResponse,
  type PwrAgentThreadInspectionContext,
} from "@pwragent/shared";
import { NavigationSnapshotTransport } from "../navigation-snapshot-transport";
import {
  DEFAULT_BACKGROUND_PR_POLLING,
  DEFAULT_PR_AUTO_DISPATCH_ALLOWED,
  DEFAULT_PAUSE_PR_AUTO_DISPATCH_WHEN_BUDGET_EMPTY,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_CAPACITY,
  DEFAULT_PR_AUTO_DISPATCH_BUDGET_REFILL_PER_MINUTE,
  DEFAULT_PULL_REQUEST_PROVIDER,
  buildAppendPinRank,
  buildFederatedThreadRef,
  buildPullRequestStatusKey,
  buildThreadIdentityKey,
  federatedThreadIdentityKey,
  isAppServerBackendKind,
  isFederationInstanceId,
  isRemoteFederationTarget,
  normalizePullRequestProvider as normalizeSharedPullRequestProvider,
  parseThreadIdentityKey,
  rankInboxThreadKeys,
} from "@pwragent/shared";
import { registerDirectoryFromDisk } from "../app-server/directory-registration-service";
import {
  disposeDesktopBackendRegistry,
  getExistingDesktopBackendRegistry,
  getDesktopBackendRegistry,
  WORKTREE_WORKING_STATE_CACHE_MAX_AGE_MS,
} from "../app-server/backend-registry";
import { materializeTranscriptImageUrlsForRenderer } from "../transcript-image-protocol";
import { hydrateLaunchpadCodexEnvironmentOptions } from "../app-server/codex-environment-config";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { getAppStateDb } from "../state/app-state";
import {
  listModelSettingsRecents,
  recordModelSettingsRecent,
} from "../state/model-settings-recents-store";
import {
  listRecentFileReferencePaths,
  recordRecentFileReferencePaths,
} from "../state/recent-file-references-store";
import {
  APP_SERVER_LIST_SKILLS_CHANNEL,
  APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL,
  APP_SERVER_RESUME_PR_AUTO_DISPATCH_BUDGET_CHANNEL,
  PR_AUTO_DISPATCH_BUDGET_CHANGED_EVENT_CHANNEL,
  GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL,
  GITHUB_PR_SAML_ENFORCEMENT_EVENT_CHANNEL,
  APP_SERVER_LIST_THREADS_CHANNEL,
  THREAD_SEARCH_CHANNEL,
  APP_SERVER_ARCHIVE_THREAD_CHANNEL,
  APP_SERVER_ARCHIVE_WORKTREE_CHANNEL,
  APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL,
  APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL,
  APP_SERVER_RESOLVE_MISSING_CODEX_THREADS_CHANNEL,
  APP_SERVER_RESTORE_THREAD_CHANNEL,
  APP_SERVER_RESTORE_WORKTREE_CHANNEL,
  APP_SERVER_RENAME_THREAD_CHANNEL,
  APP_SERVER_READ_THREAD_CHANNEL,
  APP_SERVER_ANALYZE_THREAD_TOOL_HISTORY_CHANNEL,
  APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL,
  THREAD_MIGRATION_LIST_SOURCES_CHANNEL,
  THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL,
  THREAD_MIGRATION_RETRY_CHANNEL,
  THREAD_MIGRATION_START_CHANNEL,
  FOCUSED_DIFF_ANALYZE_CHANNEL,
  NAVIGATION_GET_GH_STATUS_CHANNEL,
  NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
  NAVIGATION_REFRESH_THREAD_GIT_WORKING_STATE_CHANNEL,
  NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL,
  NAVIGATION_LIST_WORKTREE_OTHER_CHANGES_CHANNEL,
  NAVIGATION_GET_WORKTREE_OTHER_CHANGE_DIFF_CHANNEL,
  NAVIGATION_LIST_WORKTREE_UNPUBLISHED_COMMITS_CHANNEL,
  NAVIGATION_GET_WORKTREE_UNPUBLISHED_COMMIT_DIFF_CHANNEL,
  FEDERATION_JUMP_SEARCH_CHANNEL,
  NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL,
  NAVIGATION_ATTACH_DIRECTORY_TO_THREAD_CHANNEL,
  NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL,
  NAVIGATION_REMOVE_REMOTE_THREAD_PIN_CHANNEL,
  NAVIGATION_SET_REMOTE_THREAD_LOCAL_PIN_CHANNEL,
  NAVIGATION_DETACH_THREAD_PR_CHANNEL,
  NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
  NAVIGATION_SET_PR_POLLING_FOCUS_CHANNEL,
  NAVIGATION_REORDER_DIRECTORY_PINS_CHANNEL,
  NAVIGATION_REORDER_THREAD_PINS_CHANNEL,
  NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
  NAVIGATION_SET_SUBTHREADS_COLLAPSED_CHANNEL,
  NAVIGATION_SET_DIRECTORY_PIN_CHANNEL,
  NAVIGATION_SET_DIRECTORY_THREADS_COLLAPSED_CHANNEL,
  NAVIGATION_SET_THREAD_PARENT_CHANNEL,
  NAVIGATION_SET_THREAD_AGENT_CHANNEL,
  NAVIGATION_SET_THREAD_PIN_CHANNEL,
  NAVIGATION_SET_THREAD_REACTION_CHANNEL,
  NAVIGATION_SET_THREAD_TOOL_INCIDENT_NOTICE_CHANNEL,
  NAVIGATION_ACKNOWLEDGE_THREAD_SPEND_ALERT_CHANNEL,
  NAVIGATION_SET_ELIGIBLE_THREADS_PR_AUTO_DISPATCH_CHANNEL,
  NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
  NAVIGATION_LIST_MODEL_SETTINGS_RECENTS_CHANNEL,
  NAVIGATION_LIST_RECENT_FILE_REFERENCES_CHANNEL,
  NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_PICK_FILE_FROM_DISK_CHANNEL,
  NAVIGATION_PICK_REFERENCE_FROM_DISK_CHANNEL,
  NAVIGATION_INSPECT_PDF_REFERENCE_PATHS_CHANNEL,
  NAVIGATION_RENDER_COMPOSER_PDF_PREVIEW_CHANNEL,
  NAVIGATION_RECORD_MODEL_SETTINGS_RECENT_CHANNEL,
  NAVIGATION_RECORD_RECENT_FILE_REFERENCES_CHANNEL,
  NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL,
  NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL,
  NAVIGATION_SET_BROWSE_MODE_CHANNEL,
  NAVIGATION_SNAPSHOT_CHANNEL,
  NAVIGATION_UPDATE_SUBTHREAD_ORDER_CHANNEL,
  NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL,
} from "../../shared/ipc";
import { githubPrAccessTargetKey } from "../../shared/github-pr-access";
import { subscribersForChannel } from "../window-channels";
import { isFederationWindowWebContents } from "../window";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import {
  isFederationPeerUnavailableError,
} from "../federation/federation-peer-unavailable-error";
import { FocusedDiffService } from "../diff-focus/focused-diff-service";
import { renderComposerPdfPreview } from "../pdf/composer-pdf-preview";
import { getMainLogger } from "../log";
import { buildMessagingBindingsByThreadKey } from "../messaging/messaging-bindings-snapshot";
import { getDesktopAutomationService } from "../automations/desktop-automation-service";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher";
import { detectPullRequestsForThread } from "../pr-status/pr-detection";
import {
  GithubGraphqlPrClient,
  branchRefKey,
  parsePrRefFromUrl,
} from "../pr-status/github-graphql-client";
import type { BranchRef } from "../pr-status/github-graphql-client";
import {
  parseGitHubRemote,
  resolveGitHubRepoForDirectory,
  resolveGitHubReposForDirectory,
} from "../pr-status/git-remote";
import { PrPollingScheduler } from "../pr-status/pr-polling-scheduler";
import type { PrPollTarget } from "../pr-status/pr-polling-scheduler";
import { PrPollingFocusTracker } from "../pr-status/pr-polling-focus";
import {
  PrAutoDispatchCoordinator,
  buildPrRepositoryKey,
  pullRequestMatchesRepositoryKey,
} from "../pr-status/pr-auto-dispatch";
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
import { selectDiscoveryDueThreadKeys } from "../pr-status/pr-discovery";

/** Listener registered via `onPrStatusTransition`. */
type PrStatusTransitionListener = (transition: PrStatusTransition) => void;
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { resolveScratchProjectsRoots } from "../app-server/scratch-projects";
import { ThreadMigrationService } from "../app-server/thread-migration-service";
import { ProviderTranscriptThreadSearchAdapter } from "../thread-search/thread-search-provider-adapters";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import { ThreadSearchStore } from "../thread-search/thread-search-store";
import { timeStartupProfileOperation } from "../diagnostics/startup-profile-events";
import { getLiveThreadFileDiff } from "../app-server/live-diff-activity";
import {
  getThreadReplayFileDiff,
  shapeReadThreadFileDiffsForRenderer,
} from "../app-server/thread-file-diff-cache";

const isDevelopment = process.env.NODE_ENV !== "production";
const PR_STATUS_WATCH_CURRENT_OUTCOME_MAX_AGE_MS = 30_000;
const THREAD_PR_REFRESH_MIN_INTERVAL_MS = 60_000;
const USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS = 10_000;
const TERMINAL_USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS = 60_000;
const PR_STATUS_TOKEN_BUCKET_CAPACITY = 20;
const PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE = 20;
const STARTUP_DIRECTORY_GIT_STATUS_REFRESH_LIMIT = 4;
const DIRECTORY_GIT_STATUS_CACHE_MAX_AGE_MS = 5 * 60_000;
// Collapse rapid forced directory-git-status re-enqueues for the same key
// (e.g. flipping between two threads in the same repo) that land within a
// few seconds of the previous probe completing. Concurrent same-key
// requests already coalesce via `pendingDirectoryGitStatusKeys`; this
// closes the sequential post-completion gap so "747, 732, 747, 747, 732,
// 747" collapses to "747, 732".
const DIRECTORY_GIT_STATUS_FORCE_COALESCE_WINDOW_MS = 3_000;
const BACKGROUND_WORKTREE_WORKING_STATE_REFRESH_BATCH_SIZE = 8;
// PR discovery (Layer B): a slow branch-lookup rotation across ALL open threads
// to catch newly opened PRs on projects the operator is not looking at. Tick
// often, but sweep each thread rarely and only a few per tick, so discovery
// never drains the shared PR token bucket away from the fast status poller.
const PR_DISCOVERY_TICK_INTERVAL_MS = 60_000;
const PR_DISCOVERY_CADENCE_MS = 5 * 60_000;
const PR_DISCOVERY_MAX_PER_TICK = 3;
type AppServerOverlayStoreLike = OverlayStoreLike &
  Pick<
    SqliteOverlayStore,
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
    | "acknowledgeThreadSpendAlert"
  >;

type ThreadPrRefreshContext = {
  backend: AppServerBackendKind;
  threadId: string;
  branch: string;
  directoryPaths: string[];
  branchScoped: boolean;
};

const appServerLog = getMainLogger("pwragent:app-server");

/**
 * Reject directory preference writes that target the synthetic
 * catch-all bucket (`unlinked`). Both real directories
 * (`directory:*`) and workspaces (`workspace:*`) are named entries
 * the user actually browses. The `unlinked` bucket is a roll-up of
 * threads with no linked directory and doesn't model a single
 * entry, so sticky preferences there are meaningless.
 */
function rejectNonUserDirectoryKey(directoryKey: string): void {
  if (
    !directoryKey.startsWith("directory:") &&
    !directoryKey.startsWith("workspace:")
  ) {
    throw new Error(
      `Cannot persist preferences for synthetic directory entry: ${directoryKey} (only directory:* and workspace:* keys are supported)`,
    );
  }
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

function inspectPdfReferencePaths(paths: string[]): {
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

async function renderExplicitComposerPdfPreview(
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
 * Consolidate pinned remote threads into the LOCAL project groups they
 * correspond to, so the Directories lens shows them and the title-bar
 * breadcrumb (selectedDirectory resolves by threadKeys membership) carries
 * the project name. Peer paths never match viewer paths, so matching is by
 * project identity: the linked directory's label, or its path basename.
 *
 * Mirrors `buildDirectorySummaries`' one-row-per-thread invariant
 * (`pickHomeDirectory`): a multi-directory thread joins exactly ONE local
 * group — its home directory — never every group it can match. Duplicating
 * the row made selection "jump" groups, because `selectedDirectory` resolves
 * to the first directory containing the key, which is whichever sorts first,
 * not the group the user clicked in. The owner's `projectKey` is authoritative
 * when it identifies a linked directory; fallback preference is a local
 * checkout before a worktree, then linked-directory order.
 *
 * Remote threads whose project has no local counterpart receive an
 * unconfigured placeholder group. That keeps Cmd+K-mounted rows discoverable
 * in the Directories lens until Add Directory registers a matching checkout.
 */
/**
 * The single local directory group a remote thread belongs to, by project
 * identity (directory label / path basename — peer paths never match viewer
 * paths). When the owner's projectKey identifies one of its linked
 * directories, that primary project wins even if a secondary @-referenced
 * directory is a local checkout. Otherwise, home preference mirrors
 * `pickHomeDirectory`: repo checkouts (`kind: "local"`) before worktree
 * links, then the owner's linked order.
 */
function findRemoteHomeDirectoryIndex(
  directories: ReadonlyArray<{ label: string; path?: string }>,
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "projectKey">,
): number | undefined {
  const directoryIndexByName = new Map<string, number>();
  directories.forEach((directory, index) => {
    const names = new Set(
      [directory.label, directory.path ? path.basename(directory.path) : ""]
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    );
    for (const name of names) {
      if (!directoryIndexByName.has(name)) {
        directoryIndexByName.set(name, index);
      }
    }
  });
  const linkedByHomePreference = remoteLinkedDirectoriesByHomePreference(thread);
  for (const linked of linkedByHomePreference) {
    const names = [linked.label, path.basename(linked.path)]
      .map((name) => (name ?? "").trim().toLowerCase())
      .filter(Boolean);
    for (const name of names) {
      const index = directoryIndexByName.get(name);
      if (index !== undefined) {
        return index;
      }
    }
  }
  return undefined;
}

function remoteLinkedDirectoriesByHomePreference(
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "projectKey">,
): LinkedDirectorySummary[] {
  const linkedDirectories = thread.linkedDirectories ?? [];
  const projectKey = thread.projectKey;
  const primaryProjectDirectory = projectKey
    ? linkedDirectories.find((directory) =>
        linkedDirectoryMatchesProjectKey(directory, projectKey)
      )
    : undefined;
  if (primaryProjectDirectory) {
    return [primaryProjectDirectory];
  }

  return [...linkedDirectories].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "worktree" ? 1 : -1;
    }
    return 0;
  });
}

function remoteDirectoryPlaceholder(
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "projectKey">,
): NavigationDirectorySummary | undefined {
  const home = remoteLinkedDirectoriesByHomePreference(thread)[0];
  if (!home) {
    return undefined;
  }
  const label = home.label.trim() || path.basename(home.path).trim();
  if (!label) {
    return undefined;
  }

  return {
    key: `unconfigured-directory:${encodeURIComponent(label.toLowerCase())}`,
    kind: "directory",
    label,
    localAvailability: "unconfigured",
    threadKeys: [],
    needsAttentionCount: 0,
  };
}

function linkedDirectoryMatchesProjectKey(
  directory: Pick<LinkedDirectorySummary, "path" | "worktreePath">,
  projectKey: string,
): boolean {
  const normalizedProjectKey = normalizeFederatedPath(projectKey);
  if (!normalizedProjectKey) {
    return false;
  }
  return [directory.path, directory.worktreePath].some(
    (candidate) => normalizeFederatedPath(candidate) === normalizedProjectKey,
  );
}

function normalizeFederatedPath(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || undefined;
}

function attachRemoteThreadsToLocalDirectories(
  directories: NavigationSnapshot["directories"],
  remoteThreads: NavigationThreadSummary[],
): NavigationSnapshot["directories"] {
  if (remoteThreads.length === 0) {
    return directories;
  }
  const mergedDirectories = [...directories];
  const addedByDirectoryIndex = new Map<
    number,
    Array<{ threadKey: string; inInbox: boolean }>
  >();
  for (const thread of remoteThreads) {
    const threadKey = thread.federation?.ref
      ? federatedThreadIdentityKey(thread.federation.ref)
      : buildThreadIdentityKey(thread.source, thread.id);
    let homeIndex = findRemoteHomeDirectoryIndex(
      mergedDirectories,
      thread,
    );
    if (homeIndex === undefined) {
      const placeholder = remoteDirectoryPlaceholder(thread);
      if (!placeholder) {
        continue;
      }
      homeIndex = mergedDirectories.findIndex(
        (directory) => directory.key === placeholder.key,
      );
      if (homeIndex === -1) {
        homeIndex = mergedDirectories.push(placeholder) - 1;
      }
    }
    const added = addedByDirectoryIndex.get(homeIndex) ?? [];
    added.push({ threadKey, inInbox: Boolean(thread.inbox?.inInbox) });
    addedByDirectoryIndex.set(homeIndex, added);
  }
  if (addedByDirectoryIndex.size === 0) {
    return directories;
  }
  return mergedDirectories.map((directory, index) => {
    const added = addedByDirectoryIndex
      .get(index)
      ?.filter((entry) => !directory.threadKeys.includes(entry.threadKey));
    if (!added?.length) {
      return directory;
    }
    return {
      ...directory,
      threadKeys: [
        ...directory.threadKeys,
        ...added.map((entry) => entry.threadKey),
      ],
      // Unread remote rows count toward the group's "N to review" badge
      // just like local rows do.
      needsAttentionCount:
        directory.needsAttentionCount
        + added.filter((entry) => entry.inInbox).length,
    };
  });
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
        await overlayStore.getThreadOverlayStates({
          backend,
          threadIds: [...threadIds],
        }),
      ],
    ),
  );
  const overlaysByBackend = new Map(overlayEntries);

  return threads.map((thread) => {
    const overlay = overlaysByBackend.get(thread.source)?.[thread.id];
    if (!overlay?.worktreeSnapshots?.length) {
      return thread;
    }
    return {
      ...thread,
      worktreeSnapshots: overlay.worktreeSnapshots,
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

function applyDirectoryGitStatus(
  directory: NavigationSnapshot["directories"][number],
  gitStatus: NavigationDirectoryGitStatus | undefined,
): NavigationSnapshot["directories"][number] {
  const next = { ...directory };
  if (gitStatus) {
    next.gitStatus = gitStatus;
  } else {
    delete next.gitStatus;
  }
  return next;
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
    refreshMode: request.refreshMode ?? "full",
  });
}

function getRemoteNavigationSnapshotCacheKey(
  request: GetNavigationSnapshotRequest & {
    federationTarget: { scope: "remote"; instanceId: string };
  },
): string {
  // forceRefresh / refreshMode are renderer scheduling hints. The remote RPC
  // reads the same owner snapshot either way, so every variant shares one
  // last-known fallback during a disconnect.
  return JSON.stringify({
    backend: request.backend ?? "all",
    federationTarget: request.federationTarget,
    filter: request.filter ?? "",
  });
}

function buildThreadSnapshotCacheKey(
  backend: AppServerBackendScope,
  filter?: string,
): string {
  return JSON.stringify({
    backend,
    filter: filter?.trim() ?? "",
  });
}

function mergeRecentThreadsIntoCachedSnapshot(
  cachedThreads: AppServerThreadSummary[] | undefined,
  recentThreads: AppServerThreadSummary[],
): AppServerThreadSummary[] {
  if (!cachedThreads || cachedThreads.length === 0) {
    return recentThreads;
  }
  const recentByKey = new Map(
    recentThreads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread,
    ]),
  );
  const merged = cachedThreads.map((thread) => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    return recentByKey.get(threadKey) ?? thread;
  });
  const cachedKeys = new Set(
    cachedThreads.map((thread) => buildThreadIdentityKey(thread.source, thread.id)),
  );
  for (const thread of recentThreads) {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    if (!cachedKeys.has(threadKey)) {
      merged.push(thread);
    }
  }
  return merged.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

function getThreadPullRequestsRequestKey(
  backend: AppServerBackendKind,
  request: RefreshThreadPullRequestsRequest,
): string {
  return JSON.stringify({
    lookupVersion: 3,
    backend,
    threadId: request.threadId,
    provider: normalizePullRequestProvider(request.provider),
    branch: request.branch.trim(),
    directoryPaths: request.directoryPaths,
  });
}

function normalizePrLookupDirectoryPaths(directoryPaths: string[]): string[] {
  return [...new Set(directoryPaths.map((path) => path.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function toLinkedDirectoryPathId(value: string): string {
  return path.resolve(value).replace(/\\/g, "/");
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

function normalizeLinkedDirectoryPathForMatch(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed).replace(/\\/g, "/") : undefined;
}

function linkedDirectoriesMatchForDetach(
  left: Pick<LinkedDirectorySummary, "id" | "kind" | "path" | "worktreePath">,
  right: Pick<LinkedDirectorySummary, "id" | "kind" | "path" | "worktreePath">,
): boolean {
  if (left.id === right.id) {
    return true;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  return (
    normalizeLinkedDirectoryPathForMatch(left.path) ===
      normalizeLinkedDirectoryPathForMatch(right.path) &&
    normalizeLinkedDirectoryPathForMatch(left.worktreePath) ===
      normalizeLinkedDirectoryPathForMatch(right.worktreePath)
  );
}

function countDistinctLinkedDirectories(
  directories: LinkedDirectorySummary[],
): number {
  const seen = new Set<string>();
  for (const directory of directories) {
    const key = [
      directory.kind,
      normalizeLinkedDirectoryPathForMatch(directory.path),
      normalizeLinkedDirectoryPathForMatch(directory.worktreePath),
    ].join("\0");
    seen.add(key);
  }
  return seen.size;
}

function getPullRequestLookupKey(
  request: Pick<
    RefreshThreadPullRequestsRequest,
    "provider" | "branch" | "directoryPaths"
  >,
): string {
  return JSON.stringify({
    lookupVersion: 2,
    provider: normalizePullRequestProvider(request.provider),
    branch: request.branch.trim(),
    directoryPaths: normalizePrLookupDirectoryPaths(request.directoryPaths),
  });
}

function normalizePullRequestProvider(provider: string | undefined): string {
  return normalizeSharedPullRequestProvider(provider);
}

function normalizePrSummary(pr: PrSummary): PrSummary {
  const checkState = normalizePrCheckState(pr.checkState ?? pr.state);
  const headSha = normalizeCommitShas(
    pr.headSha ? [pr.headSha] : undefined,
  )?.[0];
  const normalized: PrSummary = {
    ...pr,
    provider: normalizePullRequestProvider(pr.provider),
    state: checkState,
    checkState,
    lifecycleState: pr.lifecycleState ?? legacyPrLifecycleState(pr.state),
    reviewState: pr.reviewState ?? legacyPrReviewState(pr.state),
    mergeState: pr.mergeState ?? "unknown",
    commitShas: normalizeCommitShas(pr.commitShas),
  };
  if (headSha) {
    normalized.headSha = headSha;
  } else {
    delete normalized.headSha;
  }
  const baseRefName = pr.baseRefName?.trim();
  if (baseRefName) {
    normalized.baseRefName = baseRefName;
  } else {
    delete normalized.baseRefName;
  }
  const headRefName = pr.headRefName?.trim();
  if (headRefName) {
    normalized.headRefName = headRefName;
  } else {
    delete normalized.headRefName;
  }
  const linkedDirectoryPaths = normalizePrLookupDirectoryPaths(
    pr.linkedDirectoryPaths ?? [],
  );
  if (linkedDirectoryPaths.length > 0) {
    normalized.linkedDirectoryPaths = linkedDirectoryPaths;
  } else {
    delete normalized.linkedDirectoryPaths;
  }
  return normalized;
}

function mergeLinkedDirectoryPaths(
  left: string[] | undefined,
  right: string[] | undefined,
): string[] | undefined {
  const merged = normalizePrLookupDirectoryPaths([
    ...(left ?? []),
    ...(right ?? []),
  ]);
  return merged.length > 0 ? merged : undefined;
}

function associatePrsWithLinkedDirectories(
  prs: PrSummary[],
  directoryPaths: string[],
): PrSummary[] {
  const linkedDirectoryPaths = normalizePrLookupDirectoryPaths(directoryPaths);
  return prs.map((pr) => {
    if (!pr.headSha?.trim()) {
      return pr;
    }
    return normalizePrSummary({
      ...pr,
      linkedDirectoryPaths: mergeLinkedDirectoryPaths(
        pr.linkedDirectoryPaths,
        linkedDirectoryPaths,
      ),
    });
  });
}

function stripPrLinkedDirectoryPaths(pr: PrSummary): PrSummary {
  const normalized = normalizePrSummary(pr);
  delete normalized.linkedDirectoryPaths;
  return normalized;
}

function normalizeCommitShas(commitShas: string[] | undefined): string[] | undefined {
  const normalized = [
    ...new Set(
      (commitShas ?? [])
        .map((sha) => sha.trim().toLowerCase())
        .filter((sha) => /^[0-9a-f]{40}$/.test(sha)),
    ),
  ].sort();
  return normalized.length > 0 ? normalized : undefined;
}

function dedupePrsByStatusKey(prs: PrSummary[]): PrSummary[] {
  const seen = new Set<string>();
  const out: PrSummary[] = [];
  for (const pr of prs.map(normalizePrSummary)) {
    const key = getPrStatusKey(pr);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(pr);
  }
  return out;
}

function normalizePrCheckState(
  state: string | undefined,
): NonNullable<PrSummary["checkState"]> {
  if (
    state === "passing"
    || state === "failing"
    || state === "pending"
    || state === "unknown"
  ) {
    return state;
  }
  return "unknown";
}

function legacyPrLifecycleState(state: string | undefined): PrSummary["lifecycleState"] {
  if (state === "merged" || state === "closed") {
    return state;
  }
  return "open";
}

function legacyPrReviewState(state: string | undefined): PrSummary["reviewState"] {
  return state === "draft" ? "draft" : "ready_for_review";
}

function getPrStatusKey(
  pr: Pick<PrSummary, "provider" | "org" | "repo" | "number">,
): string {
  return buildPullRequestStatusKey(pr);
}

function normalizePrStatusWatchEvents(
  events: ThreadPullRequestWatchEvent[] | undefined,
): ThreadPullRequestWatchEvent[] | undefined {
  if (events === undefined) return ["success", "failure"];
  const normalized = [...new Set(events)];
  if (
    normalized.length === 0
    || normalized.some((event) => event !== "success" && event !== "failure")
  ) {
    return undefined;
  }
  return normalized;
}

function normalizePrWatchUrl(url: string | undefined): string | undefined {
  const normalized = url?.trim().replace(/\/+$/, "").toLowerCase();
  return normalized || undefined;
}

function filterDetachedPullRequests(
  prs: PrSummary[],
  detachedPrKeys: string[] | undefined,
): PrSummary[] {
  if (!detachedPrKeys?.length) {
    return prs;
  }
  const detached = new Set(
    detachedPrKeys.map((key) => key.trim().toLowerCase()).filter(Boolean),
  );
  return prs.filter((pr) => !detached.has(getPrStatusKey(pr)));
}

/**
 * Whether two PR lists are the same for snapshot purposes.
 *
 * This decides whether a navigation snapshot is republished, so a field that
 * clients render or the main process reads for behavior but this function
 * ignores becomes a silent staleness bug: the value moves, the snapshot is
 * judged unchanged, and no window ever hears about it. Add every such field
 * here. Exported for the test that pins exactly that.
 */
export function prSummariesEqual(left: PrSummary[], right: PrSummary[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((pr, index) => {
    const candidate = right[index];
    return (
      candidate?.number === pr.number &&
      normalizePullRequestProvider(candidate.provider)
        === normalizePullRequestProvider(pr.provider) &&
      candidate.org === pr.org &&
      candidate.repo === pr.repo &&
      candidate.title === pr.title &&
      candidate.state === pr.state &&
      candidate.checkState === pr.checkState &&
      candidate.checksStillRunning === pr.checksStillRunning &&
      candidate.lifecycleState === pr.lifecycleState &&
      candidate.reviewState === pr.reviewState &&
      candidate.mergeState === pr.mergeState &&
      candidate.baseRefName === pr.baseRefName &&
      candidate.headRefName === pr.headRefName &&
      candidate.headSha === pr.headSha &&
      JSON.stringify(candidate.linkedDirectoryPaths ?? [])
        === JSON.stringify(pr.linkedDirectoryPaths ?? []) &&
      JSON.stringify(candidate.commitShas ?? []) === JSON.stringify(pr.commitShas ?? []) &&
      // Hover-card fields. They belong here for the same reason as every field
      // above: this comparison decides whether a snapshot is republished, so a
      // poll whose only movement is "+412 → +530" must not be judged unchanged.
      candidate.additions === pr.additions &&
      candidate.deletions === pr.deletions &&
      candidate.changedFiles === pr.changedFiles &&
      candidate.commitCount === pr.commitCount &&
      candidate.createdAt === pr.createdAt &&
      candidate.mergedAt === pr.mergedAt &&
      candidate.closedAt === pr.closedAt &&
      candidate.url === pr.url
    );
  });
}

type PrStatusRegistryEntry = {
  pr: PrSummary;
  fetchedAt: number;
  lastScheduledRefreshRequestedAt?: number;
  lastUserRefreshRequestedAt?: number;
};

type PrLookupRegistryEntry = {
  prs: PrSummary[];
  fetchedAt: number;
  provider: string;
  branch: string;
  directoryPaths: string[];
  lastScheduledRefreshRequestedAt?: number;
  lastUserRefreshRequestedAt?: number;
};

type PrLookupSubscriber = {
  backend: AppServerBackendKind;
  threadId: string;
  requestKey: string;
  linkedDirectoryPaths: string[];
  previousPrs: PrSummary[];
};

type PrLookupRefreshParams = {
  backend: AppServerBackendKind;
  request: RefreshThreadPullRequestsRequest;
  requestKey: string;
  lookupKey: string;
  lookupDirectoryPaths: string[];
  previousPrs: PrSummary[];
};

type PendingPrLookupRefresh = {
  authoritative: boolean;
  promise: Promise<void>;
};

type PrLookupRefreshClaim =
  | {
      refreshKey: string;
      skippedReason?: undefined;
    }
  | {
      refreshKey?: undefined;
      skippedReason: "cooldown" | "scheduled-token-bucket";
      ageMs?: number;
      minIntervalMs?: number;
      nextAllowedInMs?: number;
    };

class PrStatusTokenBucket {
  private tokens = PR_STATUS_TOKEN_BUCKET_CAPACITY;
  private updatedAt = Date.now();

  tryTake(now = Date.now()): boolean {
    const elapsedMs = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(
      PR_STATUS_TOKEN_BUCKET_CAPACITY,
      this.tokens +
        (elapsedMs * PR_STATUS_TOKEN_BUCKET_REFILL_PER_MINUTE) / 60_000,
    );
    this.updatedAt = now;

    if (this.tokens < 1) {
      return false;
    }

    this.tokens -= 1;
    return true;
  }
}

function prLogIds(prs: PrSummary[]): string[] {
  return prs.map((pr) => getPrStatusKey(pr));
}

/** Bounded sample of PR keys carried by the stale-observation debug line. */
const STALE_PR_OBSERVATION_LOG_SAMPLE = 5;

function prLogStatuses(prs: PrSummary[]): Record<string, unknown>[] {
  return prs.map((pr) => {
    const normalized = normalizePrSummary(pr);
    return {
      prKey: getPrStatusKey(normalized),
      checkState: normalized.checkState,
      checksStillRunning: normalized.checksStillRunning ?? false,
      lifecycleState: normalized.lifecycleState,
      mergeState: normalized.mergeState,
      reviewState: normalized.reviewState,
      commitCount: normalized.commitShas?.length ?? 0,
    };
  });
}

function userPrRefreshLogPayload(params: {
  backend: AppServerBackendKind;
  branch: string;
  directoryPathCount: number;
  existingLookupMatches?: boolean;
  ghAvailable?: boolean;
  lookupCacheHit?: boolean;
  lookupKey?: string;
  previousPrs?: PrSummary[];
  provider: string;
  reason?: string;
  requestKey?: string;
  threadId: string;
  trigger: NonNullable<RefreshThreadPullRequestsRequest["trigger"]>;
}): Record<string, unknown> {
  return {
    backend: params.backend,
    branch: params.branch,
    directoryPathCount: params.directoryPathCount,
    existingLookupMatches: params.existingLookupMatches,
    ghAvailable: params.ghAvailable,
    lookupCacheHit: params.lookupCacheHit,
    lookupKey: params.lookupKey,
    previousPrIds: prLogIds(params.previousPrs ?? []),
    previousPrStatuses: prLogStatuses(params.previousPrs ?? []),
    provider: params.provider,
    reason: params.reason,
    requestKey: params.requestKey,
    threadId: params.threadId,
    trigger: params.trigger,
  };
}

function pullRequestStatusFreshness(
  fetchedAt: number | undefined,
  now: number,
): Pick<
  RefreshThreadPullRequestsResponse,
  "lastStatusCheckAt" | "lastStatusCheckAgeMs"
> {
  if (!fetchedAt || fetchedAt <= 0) {
    return {};
  }
  return {
    lastStatusCheckAt: fetchedAt,
    lastStatusCheckAgeMs: Math.max(0, now - fetchedAt),
  };
}

class DesktopAppServerService {
  private focusedDiffService: FocusedDiffService | null = null;
  private prFetcher: GithubPrFetcher | undefined;
  private readonly pendingNavigationSnapshots = new Map<
    string,
    Promise<NavigationSnapshot>
  >();
  private readonly remoteNavigationSnapshotCache = new Map<
    string,
    NavigationSnapshot
  >();
  private readonly pendingThreadPullRequestRefreshes = new Map<
    string,
    Promise<RefreshThreadPullRequestsResponse>
  >();
  private readonly pendingEditCommitResolves = new Map<
    string,
    Promise<ResolveEditCommitStatesResponse>
  >();
  private readonly prStatusRegistry = new Map<string, PrStatusRegistryEntry>();
  private readonly prLookupRegistry = new Map<string, PrLookupRegistryEntry>();
  private readonly pendingPrLookupRefreshes = new Map<
    string,
    PendingPrLookupRefresh
  >();
  private readonly queuedAuthoritativePrLookupRefreshes = new Map<
    string,
    Map<string, PrLookupRefreshParams>
  >();
  private readonly prLookupSubscribers = new Map<
    string,
    Map<string, PrLookupSubscriber>
  >();
  private readonly pendingPrOverlayWrites = new Map<string, Promise<void>>();
  private readonly prStatusTokenBucket = new PrStatusTokenBucket();
  private lastPrObservationTimestamp = 0;
  private prStatusRegistryLoaded = false;
  private prStatusRegistryLoadPromise: Promise<void> | undefined;
  private prLookupRegistryLoaded = false;
  private prLookupRegistryLoadPromise: Promise<void> | undefined;
  private prGraphqlClient: GithubGraphqlPrClient | undefined;
  private readonly githubSamlBlockedRepositories = new Set<string>();
  private githubPrAuthenticationFailureNotified = false;
  private prPollingScheduler: PrPollingScheduler | undefined;
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
  private prStatusWatchCoordinator: PrStatusWatchCoordinator | undefined;
  /** Visible thread→PR attachments plus the primary workspace's repository. */
  private readonly attachedPrsByThreadKey = new Map<
    string,
    {
      backend: AppServerBackendKind;
      primaryRepoKey?: string;
      prs: PrSummary[];
    }
  >();
  /**
   * This enrichment follows overlay snapshot hashing, so retain the last value
   * sent to the renderer and invalidate when repository resolution changes.
   */
  private readonly publishedPrimaryGitRepositoriesByThreadKey = new Map<
    string,
    string | undefined
  >();
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
  private readonly lastFullNavigationThreadsByKey = new Map<
    string,
    AppServerThreadSummary[]
  >();
  // Seeded with the empty-list hash so a pinless boot never flips
  // `unchanged` on the first snapshot.
  private lastRemoteThreadPinsMergeHash = "[]";
  private readonly directoryGitStatusByKey = new Map<
    string,
    DirectoryGitStatusCacheEntry
  >();
  private directoryGitStatusCacheLoaded = false;
  private automaticDirectoryGitStatusRefreshesStarted = 0;
  private readonly lastDirectoriesByKey = new Map<
    string,
    NavigationSnapshot["directories"][number]
  >();
  private readonly pendingDirectoryGitStatusRefreshes = new Map<string, Promise<void>>();
  private readonly pendingDirectoryGitStatusKeys = new Set<string>();
  private readonly workingStateByWorktree = new Map<
    string,
    WorktreeGitWorkingStateCacheEntry
  >();
  private workingStateCacheLoaded = false;
  private readonly pendingWorktreeWorkingStateRefreshes = new Map<
    string,
    Promise<void>
  >();
  private readonly pendingWorktreeWorkingStateKeys = new Set<string>();
  // Maps a thread identity (`backend:threadId`) to its working directory so
  // a turn/command-completion event can refresh the right worktree's chips
  // without re-reading the navigation snapshot. Populated on every snapshot.
  private readonly worktreePathByThreadKey = new Map<string, string>();
  private readonly prRefreshContextByThreadKey = new Map<
    string,
    ThreadPrRefreshContext[]
  >();
  // Merged PR commits are accepted as "pushed" even when the PR head branch
  // has been deleted and no remote ref still contains those SHAs locally.
  private readonly mergedPrCommitShasByThread = new Map<
    string,
    { worktreePath: string; commitShas: Set<string> }
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
        new ThreadSearchStore(getAppStateDb()),
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
          async ({ backend, threadId, limit }) =>
            await getDesktopBackendRegistry().readThread({
              backend,
              threadId,
              limit,
            }),
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
      filter: request.filter,
    });
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
  ): Promise<ThreadSearchResponse> {
    const local = await this.getThreadSearchService().search(request);
    const federated = await getDesktopFederationRuntime().searchConnectedPeers({
      query: local.query,
      limit: request.limit,
      backend: request.filters?.backend,
    });
    const remoteResults = federated.results
      .filter((result) => isRemoteFederationTarget(result.ref.target))
      .map((result) => ({
        backend: result.thread.source,
        threadId: result.thread.id,
        identityKey: federatedThreadIdentityKey(result.ref),
        title: result.thread.title,
        titleSource: result.thread.titleSource,
        summary: result.thread.summary,
        projectKey: result.thread.projectKey,
        createdAt: result.thread.createdAt,
        updatedAt: result.thread.updatedAt,
        archivedAt: result.thread.archivedAt,
        linkedDirectories: result.thread.linkedDirectories,
        source: result.thread.source,
        gitBranch: result.thread.gitBranch,
        model: result.thread.model,
        score: result.score,
        confidence: result.thread.title.trim().toLowerCase() ===
          local.query.trim().toLowerCase()
          ? "high" as const
          : "medium" as const,
        matchReasons: [
          {
            kind: result.thread.title.trim().toLowerCase() ===
              local.query.trim().toLowerCase()
              ? "exact_title" as const
              : "title_token_overlap" as const,
            field: "title",
            value: result.thread.title,
          },
        ],
        snippets: [
          {
            scope: "metadata" as const,
            field: "title",
            text: result.thread.title,
          },
          ...(result.thread.summary
            ? [{
                scope: "metadata" as const,
                field: "summary",
                text: result.thread.summary,
              }]
            : []),
        ],
        federation: {
          ref: result.ref,
          instanceLabel: result.instanceLabel,
          peerStatus: result.peerStatus,
        },
      }));
    const limit = Math.max(1, Math.min(request.limit ?? 20, 100));
    const confidenceRank = { high: 3, medium: 2, low: 1 };
    const results = [...local.results, ...remoteResults]
      .sort(
        (left, right) =>
          confidenceRank[right.confidence] - confidenceRank[left.confidence],
      )
      .slice(0, limit);
    return {
      ...local,
      results,
      unavailableScopes: [
        ...local.unavailableScopes,
        ...federated.failures.map((failure) => ({
          scope: "metadata" as const,
          reason: "error" as const,
          message: `${failure.instanceLabel}: ${failure.error}`,
        })),
      ],
      remoteInstances: [
        ...(federated.searchedInstances ?? []).map((instance) => ({
          instanceId: instance.instanceId,
          instanceLabel: instance.instanceLabel,
          resultCount: instance.resultCount,
        })),
        ...federated.failures.map((failure) => ({
          instanceId: failure.instanceId,
          instanceLabel: failure.instanceLabel,
          resultCount: 0,
          failed: true,
          error: failure.error,
        })),
      ],
      truncated: local.truncated ||
        local.results.length + remoteResults.length > results.length,
    };
  }

  async listSkills(
    request: AppServerListSkillsRequest = {},
  ): Promise<AppServerListSkillsResponse> {
    if (request.federationTarget && isRemoteFederationTarget(request.federationTarget)) {
      return await getDesktopFederationRuntime()
        .remoteBackend(request.federationTarget)
        .listSkills({
          backend: request.backend,
          cwd: request.cwd,
          cwds: request.cwds,
          threadId: request.threadId,
        });
    }
    const backend = request.backend ?? "codex";
    const response = await getDesktopBackendRegistry().listSkills({
      backend,
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
          threadId: request.threadId,
          before: request.before,
          includeAllToolInvocations: request.includeAllToolInvocations,
          includeTurns: request.includeTurns,
          limit: request.limit,
          viewOnly: request.viewOnly,
        });
    }
    const backend = request.backend ?? "codex";
    const registry = getDesktopBackendRegistry();
    const response = await registry.readThread({
      backend,
      threadId: request.threadId,
      includeAllToolInvocations: request.includeAllToolInvocations,
      includeTurns: request.includeTurns,
      before: request.before,
      limit: request.limit,
      viewOnly: request.viewOnly,
    });

    logDebug("readThread", {
      backend,
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
    return sanitizeRendererPayload(
      shapeReadThreadFileDiffsForRenderer(materialized),
    );
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
    const response = await getDesktopBackendRegistry().archiveThread({
      ...request,
      backend,
    });
    await getDesktopFederationRuntime().ungroupRemoteChildrenOfArchivedThread({
      backend: response.backend,
      parentThreadId: response.threadId,
    });

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

  async setNavigationBrowseMode(
    request: SetNavigationBrowseModeRequest,
  ): Promise<SetNavigationBrowseModeResponse> {
    const browseMode = await this.getOverlayStore().setNavigationBrowseMode(
      request.browseMode,
    );

    logDebug("setNavigationBrowseMode", { browseMode });

    return { browseMode };
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
          getDesktopFederationRuntime()
            .remoteThreadSummaries()
            .rememberThreadNames(federationTarget.instanceId, snapshot.threads);
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
    const refreshMode = request.refreshMode ?? "full";
    const activeRecentRefresh = refreshMode === "active-recent";
    const cacheKey = buildThreadSnapshotCacheKey(backend, request.filter);
    const hasCachedFullThreads = this.lastFullNavigationThreadsByKey.has(cacheKey);
    const cachedFullThreads = this.lastFullNavigationThreadsByKey.get(cacheKey);
    const fetchedThreads = await getDesktopBackendRegistry().listThreads({
      backend: backend === "all" ? undefined : backend,
      callerReason: activeRecentRefresh
        ? "navigation-snapshot:active-recent"
        : "navigation-snapshot",
      filter: request.filter,
      forceRefresh: request.forceRefresh,
      limit: activeRecentRefresh ? 50 : undefined,
      maxPages: activeRecentRefresh ? 1 : undefined,
      skipArchivedMetadataRefresh: activeRecentRefresh,
    });
    const threads = activeRecentRefresh
      ? mergeRecentThreadsIntoCachedSnapshot(
          cachedFullThreads,
          fetchedThreads,
        )
      : fetchedThreads;
    const partialSnapshot =
      activeRecentRefresh
      && !hasCachedFullThreads;
    if (!activeRecentRefresh) {
      this.lastFullNavigationThreadsByKey.set(cacheKey, threads);
    }
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
      ...(partialSnapshot ? { partial: true } : {}),
      queuedExecutionModesByThreadKey,
      queuedTurnsByThreadKey,
      threads,
      workspaceRoots: resolveScratchProjectsRoots(),
    });
    await this.loadPrStatusRegistry();
    await this.loadPrLookupRegistry();
    this.seedPrStatusRegistryFromThreads(snapshot.threads);
    const canonicalSnapshot = this.applyCanonicalPrStatuses(snapshot.threads);
    const replaceThreadPrAttachments =
      backend === "all" && !request.filter?.trim() && !activeRecentRefresh;
    await this.rememberThreadPrAttachments(canonicalSnapshot.threads, {
      replace: replaceThreadPrAttachments,
    });
    const threadsWithPrimaryGitRepositories =
      this.applyPrimaryGitRepositories(canonicalSnapshot.threads);
    const primaryGitRepositoriesChanged =
      this.rememberPublishedPrimaryGitRepositories(
        threadsWithPrimaryGitRepositories,
        { replace: replaceThreadPrAttachments },
      );
    void this.getPrAutoDispatchCoordinator().resume();
    await this.loadDirectoryGitStatusCache();
    for (const directory of snapshot.directories) {
      this.lastDirectoriesByKey.set(directory.key, directory);
    }
    const directories = await hydrateDirectoryLaunchpads(
      snapshot.directories.map((directory) => {
        const cached = this.directoryGitStatusByKey.get(directory.key);
        if (!cached) {
          return directory;
        }
        return applyDirectoryGitStatus(directory, cached.gitStatus);
      }),
    );
    const previousDirectories = this.previousDirectoriesByBackend.get(backend);
    const directoriesUnchanged = previousDirectories
      ? directoryStatusesEqual(previousDirectories, directories)
      : false;
    this.previousDirectoriesByBackend.set(backend, directories);
    this.startDirectoryGitStatusRefresh({
      automatic: true,
      directories: snapshot.directories,
      requestKey: getNavigationSnapshotRequestKey(request),
    });

    await this.loadThreadGitWorkingStateCache();
    this.rememberThreadWorktreePaths(canonicalSnapshot.threads);
    this.rememberThreadPrRefreshContexts(canonicalSnapshot.threads);
    this.syncPrPollingSchedulerState();
    const detachedPrsByThreadKey = await this.readDetachedPrsByThreadKey(
      canonicalSnapshot.threads,
    );
    this.rememberMergedPrCommitShas(
      canonicalSnapshot.threads,
      detachedPrsByThreadKey,
    );
    const threadsWithWorkingState = await getDesktopBackendRegistry()
      .hydrateThreadGitWorkingStates(
        threadsWithPrimaryGitRepositories.map((thread) =>
          this.applyCachedWorktreeWorkingState(thread),
        ),
      );
    this.startWorktreeWorkingStateRefresh({
      automatic: true,
      worktreePaths: this.collectThreadWorktreePaths(canonicalSnapshot.threads),
    });

    const remotePins = await this.mergePinnedRemoteThreads();

    const response = {
      ...snapshot,
      threads: [...threadsWithWorkingState, ...remotePins.threads],
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
    };
    if (
      backend === "all"
      && !request.filter?.trim()
      && !activeRecentRefresh
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
      if (
        collapsed === undefined
        || directory.directoryThreadsCollapsed === collapsed
      ) {
        return directory;
      }
      changed = true;
      return {
        ...directory,
        directoryThreadsCollapsed: collapsed,
      };
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
          ? await overlayStore.listRemoteThreadPins()
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
            resolution.archived.map(async (ref) => {
              await this.getOverlayStore().removeRemoteThreadPin({ ref });
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
    const acceptedPushedCommitShas = this.getMergedPrCommitShasForWorktree(
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
        acceptedPushedCommitShas: this.getMergedPrCommitShasForWorktree(
          request.worktreePath,
        ),
        maxCommits: request.maxCommits,
        maxFilesPerCommit: request.maxFilesPerCommit,
      },
    );
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
        acceptedPushedCommitShas: this.getMergedPrCommitShasForWorktree(
          request.worktreePath,
        ),
        maxBytes: request.maxBytes,
      },
    );
  }

  private collectThreadWorktreePaths(
    threads: NavigationSnapshot["threads"],
  ): string[] {
    const paths = new Set<string>();
    for (const thread of threads) {
      const worktreePath = this.resolveThreadWorkingStatePath(thread);
      if (worktreePath) {
        paths.add(worktreePath);
      }
    }
    return [...paths];
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

  private async rememberThreadPrAttachments(
    threads: NavigationSnapshot["threads"],
    options: { replace: boolean },
  ): Promise<void> {
    const primaryRepoResolutionByPath = new Map<
      string,
      Promise<string | undefined>
    >();
    const primaryRepoKeys = await Promise.all(
      threads.map(async (thread) =>
        await resolvePrimaryThreadRepoKey(
          thread,
          primaryRepoResolutionByPath,
        ),
      ),
    );
    const liveThreadKeys = new Set<string>();
    for (const [index, thread] of threads.entries()) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      liveThreadKeys.add(threadKey);
      const primaryRepoKey = primaryRepoKeys[index];
      this.attachedPrsByThreadKey.set(threadKey, {
        backend: thread.source,
        ...(primaryRepoKey ? { primaryRepoKey } : {}),
        prs: thread.prs ?? [],
      });
      await this.syncThreadPrAutoDispatchCandidates({
        backend: thread.source,
        threadId: thread.id,
      });
    }
    if (options.replace) {
      for (const threadKey of this.attachedPrsByThreadKey.keys()) {
        if (!liveThreadKeys.has(threadKey)) {
          this.attachedPrsByThreadKey.delete(threadKey);
          const identity = parseThreadIdentityKey(threadKey);
          if (identity) {
            await this.syncThreadPrAutoDispatchCandidates(identity);
          }
        }
      }
    }
  }

  private async rememberThreadPrAttachmentUpdate(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prs: PrSummary[];
  }): Promise<void> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const current = this.attachedPrsByThreadKey.get(threadKey);
    this.attachedPrsByThreadKey.set(
      threadKey,
      {
        backend: params.backend,
        ...(current?.primaryRepoKey
          ? { primaryRepoKey: current.primaryRepoKey }
          : {}),
        prs: params.prs,
      },
    );
    await this.syncThreadPrAutoDispatchCandidates(params);
  }

  private applyPrimaryGitRepositories(
    threads: NavigationSnapshot["threads"],
  ): NavigationSnapshot["threads"] {
    return threads.map((thread) => {
      const primaryGitRepository = this.attachedPrsByThreadKey.get(
        buildThreadIdentityKey(thread.source, thread.id),
      )?.primaryRepoKey;
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

  private async syncThreadPrAutoDispatchCandidates(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    const attachment = this.attachedPrsByThreadKey.get(
      buildThreadIdentityKey(params.backend, params.threadId),
    );
    const prKeys = attachment
      ? attachment.prs
          .filter((pr) =>
            pullRequestMatchesRepositoryKey(pr, attachment.primaryRepoKey),
          )
          .map(getPrStatusKey)
      : [];
    await this.getOverlayStore().syncThreadPrAutoDispatchCandidates({
      ...params,
      prKeys,
      now: Date.now(),
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
      pullRequestMatchesRepositoryKey(pr, attachment?.primaryRepoKey),
    );
  }

  private isPrimaryPrAttached(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prKey: string;
  }): boolean {
    const attachment = this.attachedPrsByThreadKey.get(
      buildThreadIdentityKey(params.backend, params.threadId),
    );
    return attachment?.prs.some((pr) =>
      getPrStatusKey(pr) === params.prKey
      && pullRequestMatchesRepositoryKey(pr, attachment.primaryRepoKey),
    ) ?? false;
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
        const overlays = await this.getOverlayStore().getThreadOverlayStates({
          backend,
          threadIds: [...threadIds],
        });
        for (const [threadId, overlay] of Object.entries(overlays)) {
          if (overlay?.detachedPrs?.length) {
            detachedPrsByThreadKey.set(
              buildThreadIdentityKey(backend, threadId),
              overlay.detachedPrs,
            );
          }
        }
      }),
    );
    return detachedPrsByThreadKey;
  }

  private rememberMergedPrCommitShas(
    threads: NavigationSnapshot["threads"],
    detachedPrsByThreadKey: Map<string, PrSummary[]> = new Map(),
  ): void {
    for (const thread of threads) {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      this.rememberMergedPrCommitShasForThread({
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

  private rememberMergedPrCommitShasForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    worktreePath?: string;
    prs: PrSummary[];
  }): string | undefined {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const worktreePath = params.worktreePath?.trim()
      || this.worktreePathByThreadKey.get(threadKey);
    if (!worktreePath) {
      this.mergedPrCommitShasByThread.delete(threadKey);
      return undefined;
    }
    const commitShas = this.extractMergedPrCommitShas(params.prs);
    if (commitShas.length === 0) {
      this.mergedPrCommitShasByThread.delete(threadKey);
      return worktreePath;
    }
    this.mergedPrCommitShasByThread.set(threadKey, {
      worktreePath,
      commitShas: new Set(commitShas),
    });
    return worktreePath;
  }

  private extractMergedPrCommitShas(
    prs: PrSummary[] | undefined,
  ): string[] {
    return (prs ?? [])
      .filter((pr) => pr.lifecycleState === "merged" || pr.state === "merged")
      .flatMap((pr) => normalizeCommitShas(pr.commitShas) ?? []);
  }

  private getMergedPrCommitShasForWorktree(worktreePath: string): string[] {
    const accepted = new Set<string>();
    const normalizedWorktreePath = worktreePath.trim();
    for (const entry of this.mergedPrCommitShasByThread.values()) {
      if (entry.worktreePath !== normalizedWorktreePath) {
        continue;
      }
      for (const sha of entry.commitShas) {
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
      ? this.workingStateByWorktree.get(worktreePath)
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

  async refreshDirectoryGitStatusesForKeys(
    request: RefreshDirectoryGitStatusesRequest,
  ): Promise<RefreshDirectoryGitStatusesResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .refreshDirectoryGitStatuses(remoteRequest);
    }
    await this.loadDirectoryGitStatusCache();
    const directoryKeys = [
      ...new Set(request.directoryKeys.map((key) => key.trim()).filter(Boolean)),
    ];
    const directories = directoryKeys
      .map((key) => this.lastDirectoriesByKey.get(key))
      .filter((directory): directory is NavigationSnapshot["directories"][number] =>
        Boolean(directory?.path?.trim()),
      );
    const scheduledCount = this.startDirectoryGitStatusRefresh({
      automatic: false,
      directories,
      force: request.force ?? true,
      requestKey: "explicit",
    });

    return { scheduledCount };
  }

  private async loadDirectoryGitStatusCache(): Promise<void> {
    if (this.directoryGitStatusCacheLoaded) {
      return;
    }
    this.directoryGitStatusCacheLoaded = true;

    const entries = await this.getOverlayStore().readDirectoryGitStatusCache();
    for (const entry of Object.values(entries)) {
      this.directoryGitStatusByKey.set(entry.directoryKey, entry);
    }
  }

  private startDirectoryGitStatusRefresh(params: {
    automatic: boolean;
    directories: NavigationSnapshot["directories"];
    force?: boolean;
    requestKey: string;
  }): number {
    const directories = this.selectDirectoryGitStatusRefreshCandidates(params).filter(
      (directory) => !this.pendingDirectoryGitStatusKeys.has(directory.key),
    );
    if (directories.length === 0) {
      return 0;
    }

    const refreshKey = JSON.stringify({
      request: params.requestKey,
      directoryKeys: directories.map((directory) => directory.key),
      force: params.force === true,
    });
    if (this.pendingDirectoryGitStatusRefreshes.has(refreshKey)) {
      return 0;
    }

    if (params.automatic) {
      this.automaticDirectoryGitStatusRefreshesStarted += directories.length;
    }
    for (const directory of directories) {
      this.pendingDirectoryGitStatusKeys.add(directory.key);
    }

    logDebug("directoryGitStatusRefresh:scheduled", {
      mode: params.automatic ? "automatic" : "explicit",
      count: directories.length,
      automaticStarted: this.automaticDirectoryGitStatusRefreshesStarted,
      automaticLimit: STARTUP_DIRECTORY_GIT_STATUS_REFRESH_LIMIT,
    });

    const promise = this.refreshDirectoryGitStatuses(
      directories,
      params.force === true,
    )
      .catch((error) => {
        logDebug("directoryGitStatusRefresh:failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        for (const directory of directories) {
          this.pendingDirectoryGitStatusKeys.delete(directory.key);
        }
        if (this.pendingDirectoryGitStatusRefreshes.get(refreshKey) === promise) {
          this.pendingDirectoryGitStatusRefreshes.delete(refreshKey);
        }
      });
    this.pendingDirectoryGitStatusRefreshes.set(refreshKey, promise);
    return directories.length;
  }

  private selectDirectoryGitStatusRefreshCandidates(params: {
    automatic: boolean;
    directories: NavigationSnapshot["directories"];
    force?: boolean;
  }): NavigationSnapshot["directories"] {
    const candidates = params.directories.filter((directory) => {
      if (!directory.path?.trim()) {
        return false;
      }
      const cached = this.directoryGitStatusByKey.get(directory.key);
      if (params.force) {
        // Forced refreshes bypass the normal freshness gate, but still
        // collapse a burst of same-key re-enqueues that land within a few
        // seconds of the previous probe completing (e.g. rapidly flipping
        // between two threads in the same repo). In-flight requests already
        // coalesce via `pendingDirectoryGitStatusKeys`; this closes the
        // sequential post-completion gap.
        return (
          !cached ||
          Date.now() - cached.fetchedAt >=
            DIRECTORY_GIT_STATUS_FORCE_COALESCE_WINDOW_MS
        );
      }
      if (!cached) {
        return true;
      }
      if (!isFreshDirectoryGitStatusCacheEntry(cached)) {
        return true;
      }
      return (directory.latestUpdatedAt ?? 0) > (cached.directoryUpdatedAt ?? 0);
    });

    if (!params.automatic) {
      return candidates;
    }

    const remaining =
      STARTUP_DIRECTORY_GIT_STATUS_REFRESH_LIMIT -
      this.automaticDirectoryGitStatusRefreshesStarted;
    if (remaining <= 0) {
      return [];
    }

    return [...candidates]
      .sort((left, right) => (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0))
      .slice(0, remaining);
  }

  private async refreshLaunchpadDirectoryGitStatus(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<{
    gitStatus?: NavigationDirectoryGitStatus | null;
    request: EnsureDirectoryLaunchpadRequest;
  }> {
    const launchpadPath = request.directoryPath?.trim();
    const statusSourcePath =
      request.gitStatusSourcePath?.trim() || launchpadPath;
    if (!statusSourcePath) {
      return { request };
    }

    const cachedDirectory = this.lastDirectoriesByKey.get(request.directoryKey);
    const statusDirectory: NavigationSnapshot["directories"][number] = {
      key: request.directoryKey,
      kind: request.directoryKind,
      label: request.directoryLabel,
      path: statusSourcePath,
      threadKeys: [],
      needsAttentionCount: 0,
      ...(cachedDirectory?.latestUpdatedAt !== undefined
        ? { latestUpdatedAt: cachedDirectory.latestUpdatedAt }
        : {}),
    };
    const cacheDirectory = {
      ...statusDirectory,
      path: launchpadPath ?? statusSourcePath,
    };

    try {
      const registry = getDesktopBackendRegistry();
      for await (const entry of registry.readDirectoryStatusEntries([statusDirectory])) {
        const fetchedAt = Date.now();
        let gitStatus = entry.gitStatus;
        if (!gitStatus && request.gitStatusSourcePath) {
          gitStatus = {
            syncState: "status-unavailable",
            statusUnavailableReason:
              `Git branch information is unavailable for ${statusSourcePath}.`,
          };
        }
        try {
          await this.writeDirectoryGitStatusEntry({
            directory: cacheDirectory,
            directoryKey: entry.directoryKey,
            fetchedAt,
            gitStatus,
          });
        } catch (error) {
          appServerLog.warn("failed to persist launchpad branch status", {
            directoryKey: request.directoryKey,
            error: error instanceof Error ? error.message : String(error),
            statusSourcePath,
          });
        }
        if (gitStatus?.syncState === "status-unavailable") {
          appServerLog.warn("launchpad branch status unavailable", {
            directoryKey: request.directoryKey,
            error: gitStatus.statusUnavailableReason,
            statusSourcePath,
          });
        }
        return {
          gitStatus: gitStatus ?? null,
          request: gitStatus?.currentBranch
            ? {
                ...request,
                currentBranch: gitStatus.currentBranch,
              }
            : request,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appServerLog.warn("launchpad branch status refresh failed", {
        directoryKey: request.directoryKey,
        error: message,
        statusSourcePath,
      });
      return {
        gitStatus: {
          syncState: "status-unavailable",
          statusUnavailableReason: message,
        },
        request,
      };
    }

    if (request.gitStatusSourcePath) {
      const statusUnavailableReason =
        `Git branch information is unavailable for ${statusSourcePath}.`;
      appServerLog.warn("launchpad branch status unavailable", {
        directoryKey: request.directoryKey,
        error: statusUnavailableReason,
        statusSourcePath,
      });
      return {
        gitStatus: {
          syncState: "status-unavailable",
          statusUnavailableReason,
        },
        request,
      };
    }

    return { gitStatus: null, request };
  }

  private async refreshDirectoryGitStatuses(
    directories: NavigationSnapshot["directories"],
    force = false,
  ): Promise<void> {
    const refreshableDirectories = directories.filter((directory) => directory.path?.trim());
    if (refreshableDirectories.length === 0) {
      return;
    }

    const registry = getDesktopBackendRegistry();
    if (force) {
      for (const directory of refreshableDirectories) {
        registry.invalidateDirectoryStatus(directory.path);
      }
    }
    const directoryByKey = new Map(
      refreshableDirectories.map((directory) => [directory.key, directory]),
    );
    for await (const entry of registry.readDirectoryStatusEntries(refreshableDirectories)) {
      const directory = directoryByKey.get(entry.directoryKey);
      const fetchedAt = Date.now();
      await this.writeDirectoryGitStatusEntry({
        directory,
        directoryKey: entry.directoryKey,
        fetchedAt,
        gitStatus: entry.gitStatus,
      });
    }
  }

  async writeDirectoryGitStatusEntry(params: {
    directory?: NavigationSnapshot["directories"][number];
    directoryKey: string;
    fetchedAt: number;
    gitStatus?: NavigationDirectoryGitStatus;
  }): Promise<void> {
    const current = this.directoryGitStatusByKey.get(params.directoryKey);
    const directoryPath = params.directory?.path ?? current?.directoryPath;
    const directoryUpdatedAt =
      params.directory?.latestUpdatedAt ?? current?.directoryUpdatedAt;
    const cacheEntry: DirectoryGitStatusCacheEntry = {
      directoryKey: params.directoryKey,
      ...(directoryPath ? { directoryPath } : {}),
      ...(directoryUpdatedAt !== undefined ? { directoryUpdatedAt } : {}),
      fetchedAt: params.fetchedAt,
      ...(params.gitStatus ? { gitStatus: params.gitStatus } : {}),
    };
    this.directoryGitStatusByKey.set(params.directoryKey, cacheEntry);
    await this.getOverlayStore().writeDirectoryGitStatusCacheEntry(cacheEntry);
    const notification: NavigationDirectoryGitStatusUpdatedNotification = {
      method: "navigation/directoryGitStatus/updated",
      params: {
        directoryKey: params.directoryKey,
        gitStatus: params.gitStatus ?? null,
        fetchedAt: params.fetchedAt,
      },
    };
    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification,
    } as unknown as AgentEvent);
  }

  private async loadThreadGitWorkingStateCache(): Promise<void> {
    if (this.workingStateCacheLoaded) {
      return;
    }
    this.workingStateCacheLoaded = true;

    const entries = await this.getOverlayStore().readThreadGitWorkingStateCache();
    for (const entry of Object.values(entries)) {
      this.workingStateByWorktree.set(entry.worktreePath, entry);
    }
  }

  /**
   * Schedule a background per-worktree working-state probe. Mirrors
   * `startDirectoryGitStatusRefresh`: concurrent same-key requests coalesce
   * through `pendingWorktreeWorkingStateKeys`, each automatic refresh obeys a
   * bounded batch size + cache freshness, and `force` (event-driven
   * invalidation) bypasses freshness. Returns the number of worktrees scheduled.
   */
  private startWorktreeWorkingStateRefresh(params: {
    automatic: boolean;
    worktreePaths: string[];
    force?: boolean;
  }): number {
    const worktreePaths = this.selectWorktreeWorkingStateRefreshCandidates(
      params,
    ).filter((worktreePath) => !this.pendingWorktreeWorkingStateKeys.has(worktreePath));
    if (worktreePaths.length === 0) {
      return 0;
    }

    const refreshKey = JSON.stringify({
      worktreePaths,
      force: params.force === true,
    });
    if (this.pendingWorktreeWorkingStateRefreshes.has(refreshKey)) {
      return 0;
    }

    for (const worktreePath of worktreePaths) {
      this.pendingWorktreeWorkingStateKeys.add(worktreePath);
    }

    const promise = this.refreshWorktreeWorkingStates(worktreePaths)
      .catch((error) => {
        logDebug("worktreeWorkingStateRefresh:failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        for (const worktreePath of worktreePaths) {
          this.pendingWorktreeWorkingStateKeys.delete(worktreePath);
        }
        if (this.pendingWorktreeWorkingStateRefreshes.get(refreshKey) === promise) {
          this.pendingWorktreeWorkingStateRefreshes.delete(refreshKey);
        }
      });
    this.pendingWorktreeWorkingStateRefreshes.set(refreshKey, promise);
    return worktreePaths.length;
  }

  async refreshThreadGitWorkingState(
    request: RefreshThreadGitWorkingStateRequest,
  ): Promise<RefreshThreadGitWorkingStateResponse> {
    const threadKey = buildThreadIdentityKey(request.backend, request.threadId);
    const worktreePath = this.worktreePathByThreadKey.get(threadKey);
    if (!worktreePath) {
      return { scheduled: false };
    }

    await this.loadThreadGitWorkingStateCache();
    const force = request.trigger === "user";
    if (force) {
      getDesktopBackendRegistry().invalidateWorktreeWorkingState(worktreePath);
    }
    return {
      scheduled: this.startWorktreeWorkingStateRefresh({
        automatic: false,
        worktreePaths: [worktreePath],
        force,
      }) > 0,
    };
  }

  private selectWorktreeWorkingStateRefreshCandidates(params: {
    automatic: boolean;
    worktreePaths: string[];
    force?: boolean;
  }): string[] {
    const candidates = [
      ...new Set(params.worktreePaths.map((p) => p.trim()).filter(Boolean)),
    ].filter((worktreePath) => {
      if (params.force) {
        return true;
      }
      const cached = this.workingStateByWorktree.get(worktreePath);
      if (!cached) {
        return true;
      }
      return !isFreshWorktreeWorkingStateCacheEntry(cached);
    });

    if (!params.automatic) {
      return candidates;
    }

    // Stable thread ordering must not make the same prefix win forever.
    // Unseen worktrees sort first; after that, rotate the oldest probes
    // forward. Selected and hover-inspected threads use the focused/user lane.
    candidates.sort((left, right) => {
      const leftFetchedAt = this.workingStateByWorktree.get(left)?.fetchedAt;
      const rightFetchedAt = this.workingStateByWorktree.get(right)?.fetchedAt;
      if (leftFetchedAt === undefined) {
        return rightFetchedAt === undefined ? 0 : -1;
      }
      if (rightFetchedAt === undefined) {
        return 1;
      }
      return leftFetchedAt - rightFetchedAt;
    });
    return candidates.slice(
      0,
      BACKGROUND_WORKTREE_WORKING_STATE_REFRESH_BATCH_SIZE,
    );
  }

  private async refreshWorktreeWorkingStates(
    worktreePaths: string[],
  ): Promise<void> {
    const refreshable = worktreePaths.map((p) => p.trim()).filter(Boolean);
    if (refreshable.length === 0) {
      return;
    }

    for await (const entry of getDesktopBackendRegistry().readWorktreeWorkingStateEntries(
      refreshable,
      {
        acceptedPushedCommitShasByWorktreePath: Object.fromEntries(
          refreshable.map((worktreePath) => [
            worktreePath,
            this.getMergedPrCommitShasForWorktree(worktreePath),
          ]),
        ),
      },
    )) {
      await this.writeWorktreeWorkingStateEntry({
        worktreePath: entry.worktreePath,
        fetchedAt: Date.now(),
        gitWorkingState: entry.gitWorkingState,
      });
    }
  }

  private async writeWorktreeWorkingStateEntry(params: {
    worktreePath: string;
    fetchedAt: number;
    gitWorkingState?: ThreadGitWorkingState;
  }): Promise<void> {
    const previous = this.workingStateByWorktree.get(params.worktreePath);
    const fetchedAt = Math.max(
      params.fetchedAt,
      (previous?.fetchedAt ?? params.fetchedAt - 1) + 1,
    );
    const cacheEntry: WorktreeGitWorkingStateCacheEntry = {
      worktreePath: params.worktreePath,
      fetchedAt,
      ...(params.gitWorkingState ? { gitWorkingState: params.gitWorkingState } : {}),
    };
    this.workingStateByWorktree.set(params.worktreePath, cacheEntry);
    await getDesktopBackendRegistry()
      .rememberThreadGitWorkingStateCacheEntry(cacheEntry);

    const notification: NavigationThreadGitWorkingStateUpdatedNotification = {
      method: "navigation/threadGitWorkingState/updated",
      params: {
        worktreePath: params.worktreePath,
        gitWorkingState: params.gitWorkingState ?? null,
        fetchedAt,
      },
    };
    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification,
    } as unknown as AgentEvent);
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
          automatic: false,
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
    if (event.notification.method !== "thread/pullRequests/updated") return;
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

    const response = await this.getOverlayStore().markThreadSeen({
      backend,
      seenAt: request.seenAt,
      seenUpdatedAt: request.seenUpdatedAt,
      threadId: request.threadId,
    });

    logDebug("markThreadSeen", {
      backend,
      threadId: request.threadId,
      seenUpdatedAt: request.seenUpdatedAt ?? null,
    });

    return response;
  }

  async refreshThreadPullRequests(
    request: RefreshThreadPullRequestsRequest,
  ): Promise<RefreshThreadPullRequestsResponse> {
    const backend = request.backend ?? "codex";
    const requestKey = getThreadPullRequestsRequestKey(backend, request);
    const pending = this.pendingThreadPullRequestRefreshes.get(requestKey);
    if (pending) {
      if (request.trigger === "user") {
        logDebug("threadPullRequestsRefresh:coalesced-request", {
          backend,
          branch: request.branch.trim(),
          directoryPathCount: request.directoryPaths.length,
          requestKey,
          threadId: request.threadId,
          trigger: request.trigger,
        });
      }
      return await pending;
    }

    const refreshPromise = this.refreshThreadPullRequestsUncached(
      backend,
      request,
      requestKey,
    );
    this.pendingThreadPullRequestRefreshes.set(requestKey, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      this.pendingThreadPullRequestRefreshes.delete(requestKey);
    }
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
    const requestedEvents = normalizePrStatusWatchEvents(args.notifyOn);
    if (!requestedEvents) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "notifyOn must contain success, failure, or both.",
        },
      };
    }

    const overlay = await this.getOverlayStore().getThreadOverlayState({
      backend: args.backend,
      threadId,
    });
    const attachedPrs = this.primaryAttachedPrsForThread({
      backend: args.backend,
      threadId,
      prs: this.canonicalizePrs(overlay?.prs ?? []),
    });
    const requestedUrl = normalizePrWatchUrl(args.url);
    const matches = requestedUrl
      ? attachedPrs.filter((pr) => normalizePrWatchUrl(pr.url) === requestedUrl)
      : attachedPrs;
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
    if (!headSha) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "The attached pull request does not have a known head SHA yet. Check its status once, then create the watch.",
        },
      };
    }

    const prAutomation = await this.getThreadPullRequestAutomationStatus({
      backend: args.backend,
      threadId,
    });
    const failureCoveredByAutoFix = prAutomation.autoFixActive
      && requestedEvents.includes("failure");
    const coveredByAutoFix: ThreadPullRequestWatchEvent[] = failureCoveredByAutoFix
      ? ["failure" as const]
      : [];
    const notifyOn = requestedEvents;
    const currentOutcome = getPrStatusWatchOutcome(pr);
    const currentOutcomeIsFresh = Boolean(
      currentPrEntry
      && Date.now() - currentPrEntry.fetchedAt
        <= PR_STATUS_WATCH_CURRENT_OUTCOME_MAX_AGE_MS,
    );
    if (
      currentOutcome
      && (
        isTerminalPullRequest(pr)
        || (requestedEvents.includes(currentOutcome) && currentOutcomeIsFresh)
      )
    ) {
      return {
        ok: true,
        data: {
          pullRequestWatch: {
            currentOutcome,
            coveredByAutoFix,
            prAutomation,
          },
        },
      };
    }
    let watch: ThreadPullRequestWatchSummary | undefined;
    if (notifyOn.length > 0) {
      const createdAt = Date.now();
      const candidate: ThreadPullRequestWatchSummary = {
        watchId: randomUUID(),
        backend: args.backend,
        threadId,
        prKey,
        prUrl: pr.url,
        prNumber: pr.number,
        ...(pr.title ? { prTitle: pr.title } : {}),
        headSha,
        notifyOn,
        createdAt,
        failureHandledByAutoFix: coveredByAutoFix.length > 0,
      };
      const registration = await this.getOverlayStore().registerThreadPrStatusWatch({
        watch: candidate,
        now: createdAt,
      });
      watch = registration.watch;
      if (currentOutcomeIsFresh) {
        await this.getPrStatusWatchCoordinator().handleStatusSnapshot(pr, createdAt);
      }
    }

    return {
      ok: true,
      data: {
        pullRequestWatch: {
          ...(watch ? { watch } : {}),
          coveredByAutoFix,
          prAutomation: await this.getThreadPullRequestAutomationStatus({
            backend: args.backend,
            threadId,
          }),
        },
      },
    };
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
    const autoFixActive =
      autoFixEnabled
      && this.isPrAutoDispatchAvailable()
      && (waitingForPr || ownsAttachedPr);
    const isInvokingThread =
      context?.backend === params.backend
      && context.threadId === params.threadId;
    const watches = await this.getOverlayStore().listActiveThreadPrStatusWatches(
      params,
    );
    const guidance = autoFixActive && waitingForPr
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
              : "Background PR polling is active, but Auto-fix PR is off for this thread. Use watch_thread_pull_request for a bounded one-shot success/failure notification instead of polling or creating a monitor thread."
            : "Background PR polling is active, but automatic PR repair is disabled globally in Git settings. Use watch_thread_pull_request for a bounded one-shot success/failure notification instead of polling or creating a monitor thread."
          : "Background PR polling and Auto-fix PR are off. PwrAgent will not wake this thread for PR status changes.";
    return {
      backgroundPollingEnabled: this.backgroundPrPollingEnabled,
      autoFixAllowed: this.prAutoDispatchAllowed,
      autoFixEnabled,
      autoFixActive,
      ...(overlay?.prAutoDispatchPending
        ? { autoFixPending: overlay.prAutoDispatchPending }
        : {}),
      ...(watches.length > 0 ? { watches } : {}),
      guidance,
    };
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
    const overlay = await this.getOverlayStore().detachThreadPullRequest({
      backend,
      threadId: request.threadId,
      pr: request.pr,
    });
    await this.getOverlayStore().cancelThreadPrStatusWatchesForPr({
      backend,
      threadId: request.threadId,
      prKey,
      now: Date.now(),
    });
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

  private async refreshThreadPullRequestsUncached(
    backend: AppServerBackendKind,
    request: RefreshThreadPullRequestsRequest,
    requestKey: string,
  ): Promise<RefreshThreadPullRequestsResponse> {
    const now = Date.now();
    const provider = normalizePullRequestProvider(request.provider);
    const trigger = request.trigger ?? "scheduled";
    const overlay = this.getOverlayStore();
    const existing = await overlay.getThreadOverlayState({
      backend,
      threadId: request.threadId,
    });
    await this.loadPrStatusRegistry();
    await this.loadPrLookupRegistry();
    const persistedPrs = this.mergePrHistory(
      existing?.prs ?? [],
      existing?.detachedPrs ?? [],
    );
    this.rememberPrStatuses(
      persistedPrs,
      existing?.prsFetchedAt ?? 0,
      "thread-overlay",
    );
    const existingPrs = this.canonicalizePrs(persistedPrs);
    const branch = request.branch.trim();
    const lookupKey = getPullRequestLookupKey(request);
    const lookupDirectoryPaths = normalizePrLookupDirectoryPaths(
      request.directoryPaths,
    );
    const existingLookupMatches = existing?.prsRefreshKey === requestKey;
    if (existingLookupMatches) {
      this.rememberPrLookup({
        lookupKey,
        provider,
        branch,
        directoryPaths: lookupDirectoryPaths,
        prs: existingPrs,
        fetchedAt: existing?.prsFetchedAt ?? 0,
      });
    }
    const lookupEntry = this.prLookupRegistry.get(lookupKey);
    const currentLookupPrs = lookupEntry
      ? this.canonicalizePrs(lookupEntry.prs)
      : existingLookupMatches
        ? existingPrs
        : [];
    let knownPrs = this.mergePrHistory(existingPrs, currentLookupPrs);
    const visibleKnownPrs = (): PrSummary[] =>
      filterDetachedPullRequests(knownPrs, existing?.detachedPrKeys);
    const statusFetchedAt = lookupEntry?.fetchedAt
      ?? (existingPrs.length > 0 ? existing?.prsFetchedAt : undefined);
    const freshness = pullRequestStatusFreshness(statusFetchedAt, now);
    const responseFreshness = request.includeStatusFreshness === true
      ? (refreshStarted: boolean) => ({
          ...freshness,
          refreshStarted,
        })
      : () => ({});
    const fetcher = this.getPrFetcher();
    const ghAvailable = await fetcher.isGhAvailable();
    if (trigger === "user") {
      logDebug("threadPullRequestsRefresh:requested", userPrRefreshLogPayload({
        backend,
        branch,
        directoryPathCount: request.directoryPaths.length,
        existingLookupMatches,
        ghAvailable,
        lookupCacheHit: Boolean(lookupEntry),
        lookupKey,
        previousPrs: visibleKnownPrs(),
        provider,
        requestKey,
        threadId: request.threadId,
        trigger,
      }));
    }
    if (!ghAvailable) {
      if (trigger === "user") {
        logDebug("threadPullRequestsRefresh:skipped", userPrRefreshLogPayload({
          backend,
          branch,
          directoryPathCount: request.directoryPaths.length,
          ghAvailable,
          previousPrs: visibleKnownPrs(),
          provider,
          reason: "gh-unavailable",
          requestKey,
          threadId: request.threadId,
          trigger,
        }));
      }
      return {
        backend,
        threadId: request.threadId,
        provider,
        prs: visibleKnownPrs(),
        ...responseFreshness(false),
        ghAvailable: false,
      };
    }
    if (lookupEntry && lookupEntry.fetchedAt > 0) {
      knownPrs = await this.persistPullRequestLookupHit({
        backend,
        request,
        requestKey,
        persistedPrs,
        persistedRefreshKey: existing?.prsRefreshKey,
        prs: currentLookupPrs,
        fetchedAt: lookupEntry.fetchedAt,
      });
    }
    // Terminal-state short-circuit: once every cached PR for a lookup is
    // merged or closed, we do not need to re-query GitHub for the same
    // branch/directory lookup.
    // A different lookup can mean the thread moved to a new branch after
    // merging an older PR, so stale terminal chips must not block it.
    //
    // No log here on purpose — this path runs on every navigation
    // refresh tick (once a minute per renderer) for every thread with
    // a terminal PR, so logging would produce one line per thread per
    // minute of pure noise. The interesting path is the cache-miss
    // fetch below, and callers that need to observe the no-op
    // programmatically can read `shortCircuited: true` off the
    // response.
    const allExistingPrsTerminal =
      currentLookupPrs.length > 0
      && currentLookupPrs.every(
        (pr) => pr.lifecycleState === "merged" || pr.lifecycleState === "closed",
      );
    if (
      allExistingPrsTerminal
      && branch !== "HEAD"
      && request.trigger !== "user"
      && request.trigger !== "post-turn"
    ) {
      return {
        backend,
        threadId: request.threadId,
        provider,
        prs: visibleKnownPrs(),
        ghAvailable: true,
        ...responseFreshness(false),
        shortCircuited: true,
      };
    }

    if (!branch || request.directoryPaths.length === 0) {
      if (trigger === "user") {
        logDebug("threadPullRequestsRefresh:skipped", userPrRefreshLogPayload({
          backend,
          branch,
          directoryPathCount: request.directoryPaths.length,
          ghAvailable: true,
          previousPrs: visibleKnownPrs(),
          provider,
          reason: !branch ? "missing-branch" : "missing-directory-paths",
          requestKey,
          threadId: request.threadId,
          trigger,
        }));
      }
      return {
        backend,
        threadId: request.threadId,
        provider,
        prs: visibleKnownPrs(),
        ...responseFreshness(false),
        ghAvailable: true,
      };
    }

    const refreshStarted = this.startPullRequestLookupRefresh({
      backend,
      request,
      requestKey,
      lookupKey,
      lookupDirectoryPaths,
      previousPrs: knownPrs,
    });

    return {
      backend,
      threadId: request.threadId,
      provider,
      prs: visibleKnownPrs(),
      ...responseFreshness(refreshStarted),
      ghAvailable: true,
    };
  }

  private async fetchPullRequestLookup(params: {
    backend: AppServerBackendKind;
    request: RefreshThreadPullRequestsRequest;
    lookupKey: string;
    lookupDirectoryPaths: string[];
    previousPrs: PrSummary[];
  }): Promise<{ prs: PrSummary[]; fetchedAt: number }> {
    // This timestamp is an observation-order token. Capture it before the
    // network request so an older slow response cannot outrank a newer one.
    const fetchedAt = this.nextPrObservationTimestamp();
    const trigger = params.request.trigger ?? "scheduled";
    const prs = (await detectPullRequestsForThread({
      fetcher: this.getPrFetcher(),
      branch: params.request.branch.trim(),
      directoryPaths: params.request.directoryPaths,
      ...(trigger === "user" || trigger === "post-turn"
        ? { allowPrimedBranchLookup: false }
        : {}),
    })).map(normalizePrSummary);
    const retainedPrs = await this.fetchRetainedNonTerminalPullRequests({
      prs: this.getPullRequestLookupSubscriberPreviousPrs({
        lookupKey: params.lookupKey,
        fallbackPrs: params.previousPrs,
      }),
      discoveredPrs: prs,
      cwd: params.lookupDirectoryPaths[0] ?? params.request.directoryPaths[0],
    });
    const statusPrs = dedupePrsByStatusKey([...prs, ...retainedPrs]);
    const changedStatusPrs = this.rememberPrStatuses(
      statusPrs,
      fetchedAt,
      `thread-lookup:${trigger}`,
    );
    await this.writePrStatusesToCache(statusPrs, fetchedAt);
    await this.publishPullRequestStatusUpdates({
      backend: params.backend,
      prs: changedStatusPrs,
    });
    this.rememberPrLookup({
      lookupKey: params.lookupKey,
      provider: normalizePullRequestProvider(params.request.provider),
      branch: params.request.branch.trim(),
      directoryPaths: params.lookupDirectoryPaths,
      prs,
      fetchedAt,
    });
    await this.writePrLookupToCache({
      lookupKey: params.lookupKey,
      provider: normalizePullRequestProvider(params.request.provider),
      branch: params.request.branch.trim(),
      directoryPaths: params.lookupDirectoryPaths,
      prs,
      fetchedAt,
    });

    return { prs, fetchedAt };
  }

  private getPullRequestLookupSubscriberPreviousPrs(params: {
    lookupKey: string;
    fallbackPrs: PrSummary[];
  }): PrSummary[] {
    const subscribers = this.prLookupSubscribers.get(params.lookupKey);
    if (!subscribers?.size) {
      return params.fallbackPrs;
    }
    return [...subscribers.values()].flatMap((subscriber) => subscriber.previousPrs);
  }

  private async fetchRetainedNonTerminalPullRequests(params: {
    prs: PrSummary[];
    discoveredPrs: PrSummary[];
    cwd?: string;
  }): Promise<PrSummary[]> {
    const cwd = params.cwd;
    if (!cwd) {
      return [];
    }

    const discoveredKeys = new Set(
      params.discoveredPrs.map((pr) => getPrStatusKey(pr)),
    );
    const seenRetainedKeys = new Set<string>();
    const retainedPrs = params.prs
      .map(normalizePrSummary)
      .filter((pr) => {
        const key = getPrStatusKey(pr);
        if (discoveredKeys.has(key)) return false;
        if (seenRetainedKeys.has(key)) return false;
        if (pr.lifecycleState === "merged" || pr.lifecycleState === "closed") {
          return false;
        }
        seenRetainedKeys.add(key);
        return true;
      });

    if (retainedPrs.length === 0) {
      return [];
    }

    const fetcher = this.getPrFetcher();
    const refreshed = await Promise.all(
      retainedPrs.map((pr) =>
        fetcher.fetchPullRequestByUrl({ cwd, url: pr.url }),
      ),
    );
    return refreshed.filter((pr): pr is PrSummary => Boolean(pr))
      .map(normalizePrSummary);
  }

  private startPullRequestLookupRefresh(
    params: PrLookupRefreshParams,
    options: {
      additionalSubscribers?: PrLookupRefreshParams[];
      skipClaim?: boolean;
    } = {},
  ): boolean {
    const trigger = params.request.trigger ?? "scheduled";
    const authoritative = trigger === "user" || trigger === "post-turn";
    const provider = normalizePullRequestProvider(params.request.provider);
    const pending = this.pendingPrLookupRefreshes.get(params.lookupKey);
    if (pending) {
      if (authoritative && !pending.authoritative) {
        return this.queueAuthoritativePullRequestLookupRefresh(params);
      }
      this.addPullRequestLookupSubscriber(params.lookupKey, params);
      if (trigger === "user") {
        logDebug("threadPullRequestsRefresh:coalesced-background", userPrRefreshLogPayload({
          backend: params.backend,
          branch: params.request.branch.trim(),
          directoryPathCount: params.request.directoryPaths.length,
          lookupKey: params.lookupKey,
          previousPrs: params.previousPrs,
          provider,
          requestKey: params.requestKey,
          threadId: params.request.threadId,
          trigger,
        }));
      }
      return true;
    }

    let refreshKey = params.lookupKey;
    if (!options.skipClaim) {
      const claim = this.claimPullRequestLookupRefreshKey(
        params.lookupKey,
        trigger,
        provider,
        params.previousPrs.length > 0
          && params.previousPrs.every(
            (pr) => pr.lifecycleState === "merged" || pr.lifecycleState === "closed",
          ),
      );
      if (claim.skippedReason) {
        if (trigger === "user") {
          logDebug("threadPullRequestsRefresh:skipped", {
            ...userPrRefreshLogPayload({
              backend: params.backend,
              branch: params.request.branch.trim(),
              directoryPathCount: params.request.directoryPaths.length,
              lookupKey: params.lookupKey,
              previousPrs: params.previousPrs,
              provider,
              reason: claim.skippedReason,
              requestKey: params.requestKey,
              threadId: params.request.threadId,
              trigger,
            }),
            ageMs: claim.ageMs,
            minIntervalMs: claim.minIntervalMs,
            nextAllowedInMs: claim.nextAllowedInMs,
          });
        }
        return false;
      }
      refreshKey = claim.refreshKey;
    }

    this.addPullRequestLookupSubscriber(params.lookupKey, params);
    for (const subscriber of options.additionalSubscribers ?? []) {
      this.addPullRequestLookupSubscriber(params.lookupKey, subscriber);
    }
    if (trigger === "user") {
      logDebug("threadPullRequestsRefresh:background-start", userPrRefreshLogPayload({
        backend: params.backend,
        branch: params.request.branch.trim(),
        directoryPathCount: params.request.directoryPaths.length,
        lookupKey: params.lookupKey,
        previousPrs: params.previousPrs,
        provider,
        requestKey: params.requestKey,
        threadId: params.request.threadId,
        trigger,
      }));
    }
    const promise = this.fetchPullRequestLookup(params)
      .then(async ({ prs, fetchedAt }) => {
        const publishResult = await this.persistPullRequestLookupSubscribers({
          lookupKey: params.lookupKey,
          prs,
          fetchedAt,
        });
        if (trigger === "user") {
          const completedAt = Date.now();
          logDebug("threadPullRequestsRefresh:background-complete", {
            ...userPrRefreshLogPayload({
              backend: params.backend,
              branch: params.request.branch.trim(),
              directoryPathCount: params.request.directoryPaths.length,
              lookupKey: params.lookupKey,
              previousPrs: params.previousPrs,
              provider,
              requestKey: params.requestKey,
              threadId: params.request.threadId,
              trigger,
            }),
            changedThreadCount: publishResult.changedThreadCount,
            fetchedAt,
            fetchedPrIds: prLogIds(prs),
            fetchedPrStatuses: prLogStatuses(prs),
            completedAt,
            durationMs: Math.max(0, completedAt - fetchedAt),
            subscriberCount: publishResult.subscriberCount,
          });
        }
      })
      .catch((error) => {
        appServerLog.warn("background PR lookup refresh failed", {
          threadId: params.request.threadId,
          branch: params.request.branch.trim(),
          previousPrIds: prLogIds(params.previousPrs),
          provider,
          refreshKey,
          requestKey: params.requestKey,
          trigger,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (
          this.pendingPrLookupRefreshes.get(params.lookupKey)?.promise
          === promise
        ) {
          this.pendingPrLookupRefreshes.delete(params.lookupKey);
          this.prLookupSubscribers.delete(params.lookupKey);
          this.startQueuedAuthoritativePullRequestLookupRefresh(params.lookupKey);
        }
      });
    this.pendingPrLookupRefreshes.set(params.lookupKey, {
      authoritative,
      promise,
    });
    return true;
  }

  private queueAuthoritativePullRequestLookupRefresh(
    params: PrLookupRefreshParams,
  ): boolean {
    const queued = this.queuedAuthoritativePrLookupRefreshes.get(params.lookupKey)
      ?? new Map<string, PrLookupRefreshParams>();
    const threadKey = buildThreadIdentityKey(
      params.backend,
      params.request.threadId,
    );
    queued.set(threadKey, params);
    this.queuedAuthoritativePrLookupRefreshes.set(params.lookupKey, queued);
    if (params.request.trigger === "user") {
      logDebug("threadPullRequestsRefresh:queued-authoritative", userPrRefreshLogPayload({
        backend: params.backend,
        branch: params.request.branch.trim(),
        directoryPathCount: params.request.directoryPaths.length,
        lookupKey: params.lookupKey,
        previousPrs: params.previousPrs,
        provider: normalizePullRequestProvider(params.request.provider),
        requestKey: params.requestKey,
        threadId: params.request.threadId,
        trigger: "user",
      }));
    }
    return true;
  }

  private startQueuedAuthoritativePullRequestLookupRefresh(
    lookupKey: string,
  ): void {
    const queued = this.queuedAuthoritativePrLookupRefreshes.get(lookupKey);
    if (!queued?.size) {
      return;
    }
    this.queuedAuthoritativePrLookupRefreshes.delete(lookupKey);
    const [first, ...additionalSubscribers] = [...queued.values()];
    if (!first) {
      return;
    }
    this.startPullRequestLookupRefresh(first, {
      additionalSubscribers,
      skipClaim: true,
    });
  }

  private addPullRequestLookupSubscriber(
    lookupKey: string,
    params: {
      backend: AppServerBackendKind;
      request: RefreshThreadPullRequestsRequest;
      requestKey: string;
      previousPrs: PrSummary[];
    },
  ): void {
    const subscribers =
      this.prLookupSubscribers.get(lookupKey) ?? new Map<string, PrLookupSubscriber>();
    const threadKey = buildThreadIdentityKey(
      params.backend,
      params.request.threadId,
    );
    subscribers.set(threadKey, {
      backend: params.backend,
      threadId: params.request.threadId,
      requestKey: params.requestKey,
      linkedDirectoryPaths: normalizePrLookupDirectoryPaths(
        params.request.directoryPaths,
      ),
      previousPrs: params.previousPrs,
    });
    this.prLookupSubscribers.set(lookupKey, subscribers);
  }

  private async persistPullRequestLookupSubscribers(params: {
    lookupKey: string;
    prs: PrSummary[];
    fetchedAt: number;
  }): Promise<{ changedThreadCount: number; subscriberCount: number }> {
    const subscribers = this.prLookupSubscribers.get(params.lookupKey);
    if (!subscribers?.size) {
      return { changedThreadCount: 0, subscriberCount: 0 };
    }

    let changedThreadCount = 0;
    await Promise.all(
      [...subscribers.values()].map(async (subscriber) => {
        await this.enqueuePullRequestOverlayWrite({
          backend: subscriber.backend,
          threadId: subscriber.threadId,
          write: async () => {
            const overlay = this.getOverlayStore();
            // Branch changes use a different lookup key, so their refresh can
            // overlap the preceding branch's lookup. Re-read inside the
            // per-thread write queue to retain history from either lookup.
            const latest = await overlay.getThreadOverlayState({
              backend: subscriber.backend,
              threadId: subscriber.threadId,
            });
            const previousPersistedPrs = latest?.prs ?? subscriber.previousPrs;
            const latestPrs = this.mergePrHistory(
              latest?.prs ?? [],
              latest?.detachedPrs ?? [],
            );
            const previousPrs = this.mergePrHistory(
              subscriber.previousPrs,
              latestPrs,
            );
            const associatedPrs = associatePrsWithLinkedDirectories(
              params.prs,
              subscriber.linkedDirectoryPaths,
            );
            const nextPrs = this.mergePrHistory(previousPrs, associatedPrs);
            const updated = await overlay.setThreadPullRequests({
              backend: subscriber.backend,
              threadId: subscriber.threadId,
              prs: nextPrs,
              fetchedAt: params.fetchedAt,
              refreshKey: subscriber.requestKey,
            });
            const persistedPrs = updated.prs ?? [];
            if ((updated.prsFetchedAt ?? 0) > params.fetchedAt) {
              appServerLog.info("thread PR overlay observation ignored", {
                backend: subscriber.backend,
                threadId: subscriber.threadId,
                requestKey: subscriber.requestKey,
                observedAt: params.fetchedAt,
                currentObservedAt: updated.prsFetchedAt,
                currentRequestKey: updated.prsRefreshKey,
              });
              return;
            }

            if (!prSummariesEqual(previousPersistedPrs, persistedPrs)) {
              changedThreadCount += 1;
              await this.publishThreadPullRequestsUpdated({
                backend: subscriber.backend,
                threadId: subscriber.threadId,
                prs: persistedPrs,
                detachedPrs: updated.detachedPrs ?? [],
              });
            }
          },
        });
      }),
    );
    return { changedThreadCount, subscriberCount: subscribers.size };
  }

  private enqueuePullRequestOverlayWrite<T>(params: {
    backend: AppServerBackendKind;
    threadId: string;
    write: () => Promise<T>;
  }): Promise<T> {
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const previous = this.pendingPrOverlayWrites.get(threadKey) ?? Promise.resolve();
    const result = previous.then(params.write);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pendingPrOverlayWrites.set(threadKey, settled);
    void settled.then(() => {
      if (this.pendingPrOverlayWrites.get(threadKey) === settled) {
        this.pendingPrOverlayWrites.delete(threadKey);
      }
    });
    return result;
  }

  private async persistPullRequestLookupHit(params: {
    backend: AppServerBackendKind;
    request: RefreshThreadPullRequestsRequest;
    requestKey: string;
    persistedPrs: PrSummary[];
    persistedRefreshKey?: string;
    prs: PrSummary[];
    fetchedAt: number;
  }): Promise<PrSummary[]> {
    const associatedPrs = associatePrsWithLinkedDirectories(
      params.prs,
      params.request.directoryPaths,
    );
    const nextPrs = this.mergePrHistory(params.persistedPrs, associatedPrs);
    if (
      params.persistedRefreshKey === params.requestKey
      && prSummariesEqual(params.persistedPrs, nextPrs)
    ) {
      return params.persistedPrs;
    }

    const updated = await this.getOverlayStore().setThreadPullRequests({
      backend: params.backend,
      threadId: params.request.threadId,
      prs: nextPrs,
      fetchedAt: params.fetchedAt,
      refreshKey: params.requestKey,
    });
    const persistedPrs = updated.prs ?? [];
    if ((updated.prsFetchedAt ?? 0) > params.fetchedAt) {
      return persistedPrs;
    }

    if (!prSummariesEqual(params.persistedPrs, persistedPrs)) {
      await this.publishThreadPullRequestsUpdated({
        backend: params.backend,
        threadId: params.request.threadId,
        prs: persistedPrs,
        detachedPrs: updated.detachedPrs ?? [],
      });
    }
    return persistedPrs;
  }

  private claimPullRequestLookupRefreshKey(
    lookupKey: string,
    trigger: NonNullable<RefreshThreadPullRequestsRequest["trigger"]>,
    provider: string,
    terminalOnly: boolean,
  ): PrLookupRefreshClaim {
    const now = Date.now();
    const minInterval =
      trigger === "post-turn"
        ? 0
        : trigger === "user"
        ? terminalOnly
          ? TERMINAL_USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS
          : USER_THREAD_PR_REFRESH_MIN_INTERVAL_MS
        : THREAD_PR_REFRESH_MIN_INTERVAL_MS;
    const timestampField =
      trigger === "user"
        ? "lastUserRefreshRequestedAt"
        : "lastScheduledRefreshRequestedAt";
    const entry = this.prLookupRegistry.get(lookupKey);
    const lastRequestedAt = Math.max(
      entry?.[timestampField] ?? 0,
      entry?.fetchedAt ?? 0,
    );
    const ageMs = now - lastRequestedAt;
    const due = ageMs >= minInterval;
    if (!due) {
      return {
        skippedReason: "cooldown",
        ageMs,
        minIntervalMs: minInterval,
        nextAllowedInMs: minInterval - ageMs,
      };
    }
    if (trigger === "scheduled" && !this.prStatusTokenBucket.tryTake(now)) {
      return { skippedReason: "scheduled-token-bucket" };
    }

    if (entry) {
      entry[timestampField] = now;
    } else {
      this.prLookupRegistry.set(lookupKey, {
        prs: [],
        fetchedAt: 0,
        provider: normalizePullRequestProvider(provider),
        branch: "",
        directoryPaths: [],
        [timestampField]: now,
      });
    }

    return { refreshKey: lookupKey };
  }

  private rememberPrStatuses(
    prs: PrSummary[],
    fetchedAt: number,
    source: string,
  ): PrSummary[] {
    const changedPrs: PrSummary[] = [];
    const transitions: PrStatusTransition[] = [];
    const staleKeys: string[] = [];
    for (const pr of prs.map(stripPrLinkedDirectoryPaths)) {
      const key = getPrStatusKey(pr);
      const current = this.prStatusRegistry.get(key);
      if (current && current.fetchedAt > fetchedAt) {
        staleKeys.push(key);
        continue;
      }
      if (!current || !prSummariesEqual([current.pr], [pr])) {
        changedPrs.push(pr);
        // A meaningful field flip (CI, merge, conflict, draft, title) becomes a
        // typed transition. `current?.pr` undefined (first sight / cache load)
        // yields no transition, so boot does not emit a flood.
        const transition = computePrStatusTransition(current?.pr, pr);
        if (transition) {
          transition.threadKeys = this.findThreadKeysForPrKey(key);
          transitions.push(transition);
        }
      }
      this.prStatusRegistry.set(key, {
        ...current,
        pr,
        fetchedAt,
      });
      this.applyPrStatusToAttachments(pr);
    }
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
      this.emitPrStatusTransitions(transitions, { observedAt: fetchedAt, source });
    }
    return changedPrs;
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
  ): void {
    for (const transition of transitions) {
      appServerLog.info(
        "pr status transition",
        {
          ...summarizePrStatusTransition(transition),
          ...observation,
        },
      );
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
    const threadKeys: string[] = [];
    for (const [threadKey, attachment] of this.attachedPrsByThreadKey) {
      if (attachment.prs.some((pr) =>
        getPrStatusKey(pr) === prKey
        && pullRequestMatchesRepositoryKey(pr, attachment.primaryRepoKey)
      )) {
        threadKeys.push(threadKey);
      }
    }
    return threadKeys;
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

  private rememberPrLookup(entry: {
    lookupKey: string;
    provider: string;
    branch: string;
    directoryPaths: string[];
    prs: PrSummary[];
    fetchedAt: number;
  }): void {
    const current = this.prLookupRegistry.get(entry.lookupKey);
    if (current && current.fetchedAt > entry.fetchedAt) {
      return;
    }
    this.prLookupRegistry.set(entry.lookupKey, {
      ...current,
      provider: normalizePullRequestProvider(entry.provider),
      branch: entry.branch,
      directoryPaths: entry.directoryPaths,
      prs: entry.prs.map(normalizePrSummary),
      fetchedAt: entry.fetchedAt,
    });
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

  private async loadPrLookupRegistry(): Promise<void> {
    if (this.prLookupRegistryLoaded) {
      return;
    }
    if (!this.prLookupRegistryLoadPromise) {
      this.prLookupRegistryLoadPromise = (async () => {
        const entries = await this.getOverlayStore().readPrLookupCache();
        for (const entry of Object.values(entries)) {
          this.rememberPrLookup(entry);
          this.rememberPrStatuses(entry.prs, entry.fetchedAt, "pr-lookup-cache");
        }
        this.prLookupRegistryLoaded = true;
      })();
    }
    const loadPromise = this.prLookupRegistryLoadPromise;
    try {
      await loadPromise;
    } finally {
      if (this.prLookupRegistryLoadPromise === loadPromise) {
        this.prLookupRegistryLoadPromise = undefined;
      }
    }
  }

  private async writePrStatusesToCache(
    prs: PrSummary[],
    fetchedAt: number,
  ): Promise<void> {
    const entries: PrStatusCacheEntry[] = prs.map(normalizePrSummary).map((pr) => ({
      provider: normalizePullRequestProvider(pr.provider),
      prKey: getPrStatusKey(pr),
      fetchedAt,
      pr,
    }));
    await this.getOverlayStore().writePrStatusCacheEntries(entries);
  }

  private async writePrLookupToCache(entry: PrLookupCacheEntry): Promise<void> {
    await this.getOverlayStore().writePrLookupCacheEntry(entry);
  }

  private canonicalizePrs(prs: PrSummary[]): PrSummary[] {
    return prs.map((pr) => {
      const normalized = normalizePrSummary(pr);
      const canonical = this.prStatusRegistry.get(getPrStatusKey(normalized))?.pr;
      if (!canonical) {
        return normalized;
      }
      return normalizePrSummary({
        ...canonical,
        linkedDirectoryPaths: normalized.linkedDirectoryPaths,
      });
    });
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
  ): Promise<PrSummary[]> {
    await this.loadPrStatusRegistry();
    return this.canonicalizePrs(prs);
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
    const worktreePath = this.rememberMergedPrCommitShasForThread({
      ...params,
      prs: [...params.prs, ...(params.detachedPrs ?? [])],
    });
    if (worktreePath) {
      getDesktopBackendRegistry().invalidateWorktreeWorkingState(worktreePath);
      void this.loadThreadGitWorkingStateCache().then(() => {
        this.startWorktreeWorkingStateRefresh({
          automatic: false,
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

  private async publishPullRequestStatusUpdates(params: {
    backend: AppServerBackendKind;
    prs: PrSummary[];
  }): Promise<void> {
    await Promise.all(
      params.prs.map(async (pr) => {
        await getDesktopBackendRegistry().publishLocalEvent({
          backend: params.backend,
          notification: {
            method: "pullRequest/status/updated",
            params: {
              prKey: getPrStatusKey(pr),
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
  }

  /** Drop a closed window's focus so its threads leave the fast tier. */
  clearPullRequestPollingFocusForSender(senderKey: number): void {
    this.prPollingFocus.clearSender(senderKey);
  }

  private getPrGraphqlClient(): GithubGraphqlPrClient {
    if (!this.prGraphqlClient) {
      this.prGraphqlClient = new GithubGraphqlPrClient({
        getConfiguredGhCommand: () =>
          getDesktopSettingsService().resolveGhCommandPreference(),
        onAuthenticationFailure: (event) => {
          if (this.githubPrAuthenticationFailureNotified) {
            return;
          }
          this.githubPrAuthenticationFailureNotified = true;
          const notice = {
            occurredAt: Date.now(),
            ...(event.detail ? { detail: event.detail } : {}),
          };
          for (const webContents of subscribersForChannel(
            GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL,
          )) {
            if (!webContents.isDestroyed()) {
              webContents.send(
                GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL,
                notice,
              );
            }
          }
        },
        onRepositoryAccess: (event) => {
          if (event.status === "available") {
            this.githubPrAuthenticationFailureNotified = false;
          }
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

  private getPrAutoDispatchBudgetConfigFromSettings(
    settings: Pick<DesktopSettingsSnapshot, "git">,
  ): PrAutoDispatchBudgetConfig {
    return {
      capacity: settings.git.prAutoDispatchBudgetCapacity.value,
      refillPerMinute:
        settings.git.prAutoDispatchBudgetRefillPerMinute.value,
      pauseWhenEmpty:
        settings.git.pausePrAutoDispatchWhenBudgetEmpty.value,
    };
  }

  private async readPrAutoDispatchBudgetConfig(): Promise<PrAutoDispatchBudgetConfig> {
    return this.getPrAutoDispatchBudgetConfigFromSettings(
      await getDesktopSettingsService().readSettings(),
    );
  }

  /**
   * Start or stop background PR polling and automatic repair dispatch to match
   * the Git settings. Public + idempotent: called on every navigation snapshot
   * and after every settings write, so both gates take effect without a restart.
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
        const settingsService = getDesktopSettingsService();
        // Subscribe lazily on the first sync (which the first navigation
        // snapshot triggers), so a later toggle re-syncs immediately without a
        // restart. Done here rather than at IPC-registration time so tests that
        // don't stub the settings singleton aren't forced to construct it.
        if (!this.prPollingSettingsUnsubscribe) {
          this.prPollingSettingsUnsubscribe = settingsService.onConfigWritten(
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
        const settings = await settingsService.readSettings();
        backgroundPollingEnabled = settings.git.backgroundPrPolling.value;
        prAutoDispatchAllowed = settings.git.prAutoDispatchAllowed.value;
        budgetConfig = this.getPrAutoDispatchBudgetConfigFromSettings(settings);
        budgetStatus = await this.getOverlayStore().getPrAutoDispatchBudgetStatus({
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
      const status = await this.getOverlayStore().getPrAutoDispatchBudgetStatus({
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
    if (this.prPollingScheduler) {
      return;
    }
    appServerLog.info("background PR polling enabled — starting poller");
    const scheduler = new PrPollingScheduler({
      listTargets: () => this.collectPrPollTargets(),
      getFocusedThreadKeys: () => this.prPollingFocus.union(),
      isWindowVisible: () =>
        BrowserWindow.getAllWindows().some(
          (window) =>
            !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
        ),
      // One token per admitted GraphQL batch (which covers up to a batch of
      // PRs), not per PR. Any paginated status-context reads stay within that
      // admitted batch.
      tryTakeToken: () => this.prStatusTokenBucket.tryTake(),
      fetchPullRequests: async (refs) =>
        await this.getPrGraphqlClient().fetchPullRequests(refs),
      getObservationTimestamp: () => this.nextPrObservationTimestamp(),
      applyResults: async (prs, fetchedAt) =>
        await this.applyPolledPrStatuses(prs, fetchedAt),
    });
    this.prPollingScheduler = scheduler;

    // The registries are lazily hydrated from sqlite; polling before they load
    // would see an empty target list and idle for a tick.
    void Promise.all([this.loadPrStatusRegistry(), this.loadPrLookupRegistry()])
      .then(() => {
        // A late toggle-off could have torn the scheduler down while the
        // registries were still loading; don't resurrect it.
        if (this.prPollingScheduler !== scheduler) {
          return;
        }
        scheduler.start();
        this.startPrDiscoveryRefresh();
        appServerLog.info("background PR polling started", {
          trackedPrCount: this.collectPrPollTargets().length,
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
    const visible = BrowserWindow.getAllWindows().some(
      (window) => !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
    );
    if (!visible) {
      return;
    }

    const now = Date.now();
    const threadKeys = [...this.prRefreshContextByThreadKey.keys()];
    this.prunePrDiscoveryState(threadKeys);

    const due = selectDiscoveryDueThreadKeys({
      threadKeys,
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
    const wanted = new Map<
      string,
      { cwd: string; branch: string; refs: BranchRef[] }
    >();
    for (const context of contexts) {
      const branch = context.branch.trim();
      // "HEAD" contexts are not branch lookups, and the detection path skips
      // default branches entirely — priming either would be wasted work.
      if (!branch || branch === "HEAD") {
        continue;
      }
      for (const cwd of context.directoryPaths) {
        const dedupeKey = `${cwd} ${branch}`;
        if (wanted.has(dedupeKey)) {
          continue;
        }
        const repos = await resolveGitHubReposForDirectory(cwd);
        if (repos.length === 0) {
          continue;
        }
        wanted.set(dedupeKey, {
          cwd,
          branch,
          refs: repos.map((repo) => ({
            owner: repo.owner,
            repo: repo.repo,
            branch,
          })),
        });
      }
    }

    if (wanted.size === 0) {
      return;
    }

    const entries = [...wanted.values()];
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
          prs: answers.some((answer) => answer === undefined)
            ? undefined
            : dedupePrsByStatusKey(answers.flatMap((answer) => answer ?? [])),
        };
      })
      .filter(
        (entry): entry is { cwd: string; branch: string; prs: PrSummary[] } =>
          entry.prs !== undefined,
      );
    if (primed.length === 0) {
      return;
    }
    this.getPrFetcher().primeBranchLookup(primed);
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
   * Uses the visible per-thread attachment set populated by navigation and
   * attachment events. This includes explicit PRs on directoryless threads
   * and excludes detached PRs even though lookup history retains them for
   * non-UI bookkeeping.
   */
  private collectPrPollTargets(): PrPollTarget[] {
    const byKey = new Map<string, PrPollTarget>();
    this.prPollBackendByKey.clear();

    for (const [threadKey, attachment] of this.attachedPrsByThreadKey) {
      for (const pr of attachment.prs.filter((candidate) =>
        pullRequestMatchesRepositoryKey(candidate, attachment.primaryRepoKey)
      )) {
        const prKey = getPrStatusKey(pr);
        const latest = this.prStatusRegistry.get(prKey)?.pr ?? pr;
        if (isTerminalPullRequest(latest)) continue;
        this.prPollBackendByKey.set(prKey, attachment.backend);
        const existing = byKey.get(prKey);
        if (existing) {
          if (!existing.threadKeys.includes(threadKey)) {
            existing.threadKeys.push(threadKey);
          }
          continue;
        }
        byKey.set(prKey, { prKey, pr: latest, threadKeys: [threadKey] });
      }
    }
    return [...byKey.values()];
  }

  private async handlePrAutoDispatchSnapshots(
    prs: PrSummary[],
    observedAt: number,
    operatorInitiated = false,
  ): Promise<void> {
    await this.refreshPrAutoDispatchBudgetSafetyStop();
    const coordinator = this.getPrAutoDispatchCoordinator();
    for (const pr of prs) {
      const prKey = getPrStatusKey(pr);
      const winner = await this.getOverlayStore()
        .getPrAutoDispatchCandidateWinner({ prKey });
      const threadKeys = winner
        ? [buildThreadIdentityKey(winner.backend, winner.threadId)]
        : [];
      const outcomes = threadKeys.length > 0
        ? await coordinator.handleStatusSnapshot({
            pr,
            threadKeys,
            observedAt,
            backgroundPollingEnabled: this.isPrAutoDispatchAvailable(),
            operatorInitiated,
          })
        : [];
      for (const outcome of outcomes) {
        appServerLog.info("pr auto dispatch", { prKey, ...outcome });
      }
      if (this.backgroundPrPollingEnabled) {
        const failureCoveredThreadKeys = new Set(
          outcomes.flatMap((outcome) =>
            outcome.status === "scheduled"
            || outcome.status === "pending"
              ? [outcome.threadKey]
              : [],
          ),
        );
        const dispatched = await this.getPrStatusWatchCoordinator()
          .handleStatusSnapshot(pr, observedAt, failureCoveredThreadKeys);
        if (dispatched > 0) {
          appServerLog.info("pr status watch completed", {
            prKey,
            watchCount: dispatched,
          });
        }
      }
    }
  }

  async handleThreadPrAutoDispatchPreference(
    request: SetThreadPrAutoDispatchRequest,
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
    requests: SetThreadPrAutoDispatchRequest[],
  ): Promise<void> {
    if (requests.length === 0) {
      return;
    }

    const coordinator = this.getPrAutoDispatchCoordinator();
    const disabledRequests = requests.filter((request) => !request.enabled);
    const enabledRequests = requests.filter((request) => request.enabled);

    const previouslyEligiblePrs: PrSummary[] = [];
    for (const request of disabledRequests) {
      const attachment = this.attachedPrsByThreadKey.get(
        buildThreadIdentityKey(request.backend, request.threadId),
      );
      previouslyEligiblePrs.push(
        ...(attachment?.prs ?? []).filter((pr) =>
          pullRequestMatchesRepositoryKey(pr, attachment?.primaryRepoKey),
        ),
      );
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
      const overlay = await this.getOverlayStore().getThreadOverlayState(request);
      const prs = this.canonicalizePrs(overlay?.prs ?? []);
      await this.rememberThreadPrAttachmentUpdate({ ...request, prs });
      await coordinator.resetForOperator(request);
      primaryPrs.push(...this.primaryAttachedPrsForThread({ ...request, prs }));
    }
    if (!this.isPrAutoDispatchAvailable()) {
      return;
    }

    const uniquePrimaryPrs = dedupePrsByStatusKey(primaryPrs);
    await this.handlePrAutoDispatchSnapshots(
      uniquePrimaryPrs,
      this.nextPrObservationTimestamp(),
      true,
    );

    const refs = [
      ...new Map(
        uniquePrimaryPrs.flatMap((pr) => {
          const ref = parsePrRefFromUrl(pr.url);
          return ref ? [[`${ref.owner}/${ref.repo}#${ref.number}`, ref] as const] : [];
        }),
      ).values(),
    ];
    if (refs.length === 0) {
      return;
    }
    const refreshed = await this.getPrGraphqlClient().fetchPullRequests(refs);
    if (refreshed.length === 0) {
      return;
    }
    const fetchedAt = this.nextPrObservationTimestamp();
    const changed = this.rememberPrStatuses(
      refreshed,
      fetchedAt,
      "auto-fix-enable",
    );
    await this.writePrStatusesToCache(refreshed, fetchedAt);
    await this.publishPullRequestStatusUpdates({
      backend: enabledRequests[0]!.backend,
      prs: changed,
    });
    await this.handlePrAutoDispatchSnapshots(
      refreshed,
      fetchedAt,
      true,
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
    const snapshot = await this.getNavigationSnapshot({
      backend: "all",
      refreshMode: "full",
    });
    const eligibleThreads = snapshot.threads.filter((thread) => {
      const attachment = this.attachedPrsByThreadKey.get(
        buildThreadIdentityKey(thread.source, thread.id),
      );
      return Boolean(
        attachment?.primaryRepoKey
        && attachment.prs.some((pr) =>
          pullRequestMatchesRepositoryKey(pr, attachment.primaryRepoKey)
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
  ): Promise<string[]> {
    // The GraphQL client fetches only the PR's head commit (see the cost note
    // in github-graphql-client). Union forward so a status poll does not
    // overwrite a richer commit set retained from an older snapshot.
    const merged = prs.map((pr) => {
      const previous = this.prStatusRegistry.get(getPrStatusKey(pr))?.pr;
      const commitShas = mergeCommitShas(previous?.commitShas, pr.commitShas);
      return commitShas.length > 0 ? { ...pr, commitShas } : pr;
    });

    const changed = this.rememberPrStatuses(merged, fetchedAt, "background-poll");
    await this.handlePrAutoDispatchSnapshots(merged, fetchedAt);
    if (changed.length === 0) {
      return [];
    }

    await this.writePrStatusesToCache(changed, fetchedAt);

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
        await this.publishPullRequestStatusUpdates({ backend, prs }),
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
    if (!this.prStatusTokenBucket.tryTake()) {
      throw new Error("PR status refresh budget is temporarily exhausted");
    }
    const refreshed = await this.getPrGraphqlClient().fetchPullRequests(
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

  async getGhStatus(request: GetGhStatusRequest): Promise<GhStatus> {
    const fetcher = this.getPrFetcher();
    if (request.recheck) {
      fetcher.invalidateGhCaches();
      this.getPrGraphqlClient().invalidateToken();
    }
    // The fetcher logs once per fresh probe (cache + in-flight dedup
    // keep StrictMode mount duplicates silent). The IPC layer just
    // returns the parsed status.
    return await fetcher.getAuthStatus();
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
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .setThreadPin(remoteRequest);
    }
    const backend = request.backend ?? "codex";

    const overlay = await this.getOverlayStore().setThreadPin({
      backend,
      threadId: request.threadId,
      pinnedRank: request.pinnedRank,
    });

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

  async setThreadAgent(
    request: SetThreadAgentRequest,
  ): Promise<SetThreadAgentResponse> {
    const backend = request.backend ?? "codex";

    const overlay = await this.getOverlayStore().setThreadAgent({
      backend,
      threadId: request.threadId,
      agent: request.agent,
    });

    logDebug("setThreadAgent", {
      backend,
      threadId: request.threadId,
      agentName: overlay.agent?.name ?? null,
      instructionLineCount: overlay.agent?.instructionLineCount ?? 0,
      instructionsTooLong: overlay.agent?.instructionsTooLong ?? false,
    });

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
      agent: overlay.agent,
    };
  }

  async reorderThreadPins(
    request: ReorderThreadPinsRequest,
  ): Promise<ReorderThreadPinsResponse> {
    if (
      request.federationTarget
      && isRemoteFederationTarget(request.federationTarget)
    ) {
      const { federationTarget, ...remoteRequest } = request;
      return await getDesktopFederationRuntime()
        .remoteBackend(federationTarget)
        .reorderThreadPins(remoteRequest);
    }
    // The pinned section interleaves local pins and viewer-owned remote
    // pins. The store assigns ranks from the FULL requested order in one
    // transaction, routing each key to its own storage — local thread
    // overlay vs the remote pin row — so remote ranks never reach the owner
    // and a mixed reorder is atomic.
    const overlayStore = this.getOverlayStore();
    const remotePins =
      typeof overlayStore.listRemoteThreadPins === "function"
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
      remoteRefsByKey,
    });

    logDebug("reorderThreadPins", {
      pinCount: request.threadKeys.length,
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
    await this.rankRemotePinForVisibility(request, companionParentRef);

    logDebug("addRemoteThreadPin", {
      backend: request.ref.backend,
      instanceId,
      threadId: request.ref.threadId,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend: request.ref.backend,
      notification: {
        method: "navigation/remoteThreadPins/changed",
        params: {
          instanceId,
          threadId: request.ref.threadId,
          pinned: true,
        },
      },
    });

    return { pin };
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
      const parentSummary = await getDesktopFederationRuntime()
        .remoteThreadSummaries()
        .threadFromPeer({
          target: { scope: "remote", instanceId: parentInstanceId },
          backend: parentBackend,
          threadId: parentThreadId,
        });
      if (!parentSummary) {
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
      await getDesktopBackendRegistry().publishLocalEvent({
        backend: parentBackend,
        notification: {
          method: "navigation/remoteThreadPins/changed",
          params: {
            instanceId: parentInstanceId,
            threadId: parentThreadId,
            pinned: true,
          },
        },
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
   * so it surfaces in Pins. The top-level row is the companion parent when
   * one is pinned; otherwise the thread itself, since a child whose parent
   * is absent from the list renders top-level. Reads overlay-store scans and
   * the cached directory summaries from the last snapshot build — never a
   * fresh snapshot, so pin latency stays independent of backends and peers.
   * Best-effort; the pin itself must succeed regardless.
   */
  private async rankRemotePinForVisibility(
    request: AddRemoteThreadPinRequest,
    companionParentRef: FederatedThreadRef | undefined,
  ): Promise<void> {
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
      const pinnedRank = buildAppendPinRank([
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
      await getDesktopBackendRegistry().publishLocalEvent({
        backend: targetRef.backend,
        notification: {
          method: "navigation/remoteThreadPins/changed",
          params: {
            instanceId:
              targetRef.target.scope === "remote"
                ? targetRef.target.instanceId
                : "",
            threadId: targetRef.threadId,
            pinned: true,
          },
        },
      });
    } catch (error) {
      appServerLog.warn("Remote pin visibility rank failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
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
        },
      },
    });
    return { ref: request.ref, pinnedRank: result.pinnedRank };
  }

  async jumpSearchRemoteThreads(
    request: FederationJumpSearchRequest,
  ): Promise<FederationJumpSearchResponse> {
    return await getDesktopFederationRuntime()
      .remoteThreadSummaries()
      .searchForJump(request);
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
    const backend = request.backend ?? "codex";
    const threadIds = await this.getOverlayStore().updateSubthreadOrder({
      backend,
      parentThreadId: request.parentThreadId,
      threadIds: request.threadIds,
    });

    logDebug("updateSubthreadOrder", {
      backend,
      parentThreadId: request.parentThreadId,
      childCount: threadIds.length,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend,
      notification: {
        method: "thread/subthreadOrder/updated",
        params: {
          parentThreadId: request.parentThreadId,
          threadIds,
        },
      },
    });

    return { backend, parentThreadId: request.parentThreadId, threadIds };
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

  /**
   * Directory pin handlers (plan 2026-05-09-002, Unit G). Mirror of
   * `setThreadPin` / `reorderThreadPins` with the `backend` dim
   * dropped. The handlers reject pseudo-directory keys (workspace /
   * unlinked) — these are synthesized aggregator entries that don't
   * represent a user-picked folder, so pinning them is meaningless.
   * The check is on the key prefix rather than a snapshot lookup
   * because the overlay store doesn't have visibility into the
   * snapshot at write time, and we want the rejection to be
   * deterministic.
   *
   * `publishLocalEvent` reuses the existing local-bus infrastructure
   * (no per-directory bus scope — these are global events on the
   * default backend `codex` for routing purposes; the renderer
   * listens for the `method` regardless of `backend`).
   */
  async setDirectoryPin(
    request: SetDirectoryPinRequest,
  ): Promise<SetDirectoryPinResponse> {
    rejectNonUserDirectoryKey(request.directoryKey);

    const overlay = await this.getOverlayStore().setDirectoryPin({
      directoryKey: request.directoryKey,
      pinnedRank: request.pinnedRank,
    });

    logDebug("setDirectoryPin", {
      directoryKey: request.directoryKey,
      pinnedRank: overlay.pinnedRank ?? null,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification: overlay.pinnedRank
        ? {
            method: "directory/pin/added",
            params: {
              directoryKey: request.directoryKey,
              pinnedRank: overlay.pinnedRank,
            },
          }
        : {
            method: "directory/pin/removed",
            params: {
              directoryKey: request.directoryKey,
            },
          },
    });

    return {
      directoryKey: request.directoryKey,
      pinnedRank: overlay.pinnedRank,
    };
  }

  async reorderDirectoryPins(
    request: ReorderDirectoryPinsRequest,
  ): Promise<ReorderDirectoryPinsResponse> {
    for (const directoryKey of request.directoryKeys) {
      rejectNonUserDirectoryKey(directoryKey);
    }

    const pinnedRanks = await this.getOverlayStore().reorderDirectoryPins({
      directoryKeys: request.directoryKeys,
    });

    logDebug("reorderDirectoryPins", {
      pinCount: request.directoryKeys.length,
    });

    await getDesktopBackendRegistry().publishLocalEvent({
      backend: "codex",
      notification: {
        method: "directory/pin/reordered",
        params: {
          pinnedRanks,
        },
      },
    });

    return { pinnedRanks };
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
        },
      );
      const branchName = reconcileRemoteLaunchpadBranch(
        localResponse.launchpad.branchName,
        ownerGitStatus,
      );
      return {
        ...localResponse,
        launchpad: {
          ...localResponse.launchpad,
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
      };
    }

    const refreshed = await this.refreshLaunchpadDirectoryGitStatus(request);
    const response = await getDesktopBackendRegistry().ensureDirectoryLaunchpad(
      refreshed.request,
    );
    return {
      ...response,
      ...(refreshed.gitStatus !== undefined
        ? { gitStatus: refreshed.gitStatus }
        : {}),
    };
  }

  async updateDirectoryLaunchpad(
    request: UpdateDirectoryLaunchpadRequest,
  ): Promise<UpdateDirectoryLaunchpadResponse> {
    return await getDesktopBackendRegistry().updateDirectoryLaunchpad(request);
  }

  async resetDirectoryLaunchpad(
    request: ResetDirectoryLaunchpadRequest,
  ): Promise<ResetDirectoryLaunchpadResponse> {
    return await getDesktopBackendRegistry().resetDirectoryLaunchpad(request);
  }

  async pickDirectoryFromDisk(
    parentWindow?: BrowserWindow,
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
    const window =
      parentWindow ?? BrowserWindow.getFocusedWindow() ?? undefined;
    // Open where the user last browsed (the parent of their last pick), else the
    // home folder — much friendlier than the OS default, which is Documents on a
    // fresh Windows profile and looks like you can't escape it.
    const defaultPath = this.lastPickedDirectoryParent ?? os.homedir();
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: "Add directory",
          buttonLabel: "Add directory",
          defaultPath,
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          title: "Add directory",
          buttonLabel: "Add directory",
          defaultPath,
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    this.lastPickedDirectoryParent = path.dirname(result.filePaths[0]);
    return { canceled: false, path: result.filePaths[0] };
  }

  async pickFileFromDisk(
    parentWindow?: BrowserWindow,
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

    const window =
      parentWindow ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const defaultPath = this.lastPickedDirectoryParent ?? os.homedir();
    const options = {
      title: "Add file",
      buttonLabel: "Add file",
      defaultPath,
      properties: ["openFile", "multiSelections"] as Array<
        "openFile" | "multiSelections"
      >,
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
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
    parentWindow?: BrowserWindow,
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

    const window =
      parentWindow ?? BrowserWindow.getFocusedWindow() ?? undefined;
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
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
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
      files: listRecentFileReferencePaths(getAppStateDb()).map((filePath) => ({
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
    recordRecentFileReferencePaths(getAppStateDb(), request.paths ?? []);
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
      recents: listModelSettingsRecents(getAppStateDb(), request.scope),
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
    recordModelSettingsRecent(getAppStateDb(), request.scope, request.recent);
  }

  async registerDirectoryFromDisk(
    request: RegisterDirectoryFromDiskRequest,
  ): Promise<RegisterDirectoryFromDiskResponse> {
    const response = await registerDirectoryFromDisk(request, {
      ensureDirectoryLaunchpad: (req) => this.ensureDirectoryLaunchpad(req),
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

    const directoryPathId = toLinkedDirectoryPathId(registered.directoryPath);
    const directory: LinkedDirectorySummary = {
      id: directoryPathId,
      kind: "local",
      label: registered.directoryLabel,
      path: directoryPathId,
    };
    await this.getOverlayStore().addLinkedDirectory({
      backend,
      threadId: request.threadId,
      directory,
    });

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
  }

  async detachDirectoryFromThread(
    request: DetachDirectoryFromThreadRequest,
  ): Promise<DetachDirectoryFromThreadResponse> {
    const backend = request.backend ?? "codex";
    const overlay = await this.getOverlayStore().getThreadOverlayState({
      backend,
      threadId: request.threadId,
    });
    const currentDirectories = overlay?.extraLinkedDirectories ?? [];
    const matched = currentDirectories.find((directory) =>
      linkedDirectoriesMatchForDetach(directory, request.directory),
    );
    if (!matched) {
      return {
        ok: false,
        backend,
        threadId: request.threadId,
        reason: "primary-directory",
        message:
          "Only secondary directories attached to this thread can be detached.",
      };
    }
    const fullThread = await this.listThreads({ backend })
      .then((response) =>
        response.threads.find((thread) => thread.id === request.threadId),
      )
      .catch(() => undefined);
    const totalLinkedDirectories = countDistinctLinkedDirectories([
      ...(fullThread?.linkedDirectories ?? []),
      ...currentDirectories,
    ]);
    if (totalLinkedDirectories <= 1) {
      return {
        ok: false,
        backend,
        threadId: request.threadId,
        reason: "last-directory",
        message:
          "Cannot detach the last linked directory from a thread.",
      };
    }

    const next = await this.getOverlayStore().removeLinkedDirectory({
      backend,
      threadId: request.threadId,
      directory: matched,
    });

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
      directories: next.extraLinkedDirectories,
    };
  }

  async analyzeFocusedDiff(
    request: FocusedDiffAnalysisRequest
  ): Promise<FocusedDiffAnalysisResponse> {
    // Diff condensation is gated by an experimental setting. When the
    // user has it disabled, never call the focused-diff service — return
    // the synthetic "full" response that the renderer treats as
    // "render every hunk, hide nothing". This is the diff-eliding gate
    // that keeps us from sending unsolicited structured-generation requests.
    //
    // PWRAGENT_FOCUSED_DIFF_TEST_RESPONSE bypasses the gate so E2Es that
    // exercise the focused-diff path keep working with the default-off
    // setting; without that bypass the override (consumed inside
    // FocusedDiffService.analyze) never gets a chance to run.
    const settings = await getDesktopSettingsService().readSettings();
    const condensation = settings.experimental.diffCondensation;
    const testOverridePresent = Boolean(
      process.env.PWRAGENT_FOCUSED_DIFF_TEST_RESPONSE,
    );
    if (!condensation.enabled.value && !testOverridePresent) {
      logDebug("analyzeFocusedDiff", {
        filePath: request.filePath ?? null,
        hunkCount: request.hunks.length,
        mode: "full",
        source: "condensation-disabled",
        hiddenHunkCount: 0,
      });
      return {
        mode: "full",
        source: "condensation-disabled",
        hiddenHunkIndices: [],
        hiddenHunkCount: 0,
        decisions: request.hunks.map((hunk) => ({
          index: hunk.index,
          disposition: "show" as const,
          reasonCode: "keep" as const,
          reason: "diff condensation disabled in settings",
          confidence: 1,
        })),
      };
    }

    const response = await this.getFocusedDiffService().analyze(request);

    logDebug("analyzeFocusedDiff", {
      filePath: request.filePath ?? null,
      hunkCount: request.hunks.length,
      mode: response.mode,
      source: response.source,
      hiddenHunkCount: response.hiddenHunkCount,
    });

    return response;
  }

  async close(): Promise<void> {
    this.focusedDiffService = null;
    this.prFetcher = undefined;
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
    this.githubPrAuthenticationFailureNotified = false;
    this.prPollingFocus.clear();
    this.prPollBackendByKey.clear();
    this.prStatusTransitionListeners.clear();
    this.prAutoDispatchCoordinator?.close();
    this.prAutoDispatchCoordinator = undefined;
    this.prStatusWatchCoordinator = undefined;
    this.attachedPrsByThreadKey.clear();
    this.publishedPrimaryGitRepositoriesByThreadKey.clear();
    this.pendingNavigationSnapshots.clear();
    this.remoteNavigationSnapshotCache.clear();
    this.pendingThreadPullRequestRefreshes.clear();
    this.pendingEditCommitResolves.clear();
    this.prStatusRegistry.clear();
    this.lastPrObservationTimestamp = 0;
    this.prLookupRegistry.clear();
    this.pendingPrLookupRefreshes.clear();
    this.queuedAuthoritativePrLookupRefreshes.clear();
    this.prLookupSubscribers.clear();
    this.pendingPrOverlayWrites.clear();
    this.prStatusRegistryLoaded = false;
    this.prStatusRegistryLoadPromise = undefined;
    this.prLookupRegistryLoaded = false;
    this.prLookupRegistryLoadPromise = undefined;
    this.pendingDirectoryGitStatusRefreshes.clear();
    this.pendingDirectoryGitStatusKeys.clear();
    this.previousDirectoriesByBackend.clear();
    this.lastFullNavigationThreadsByKey.clear();
    this.directoryGitStatusByKey.clear();
    this.directoryGitStatusCacheLoaded = false;
    this.automaticDirectoryGitStatusRefreshesStarted = 0;
    this.lastDirectoriesByKey.clear();
    this.pendingWorktreeWorkingStateRefreshes.clear();
    this.pendingWorktreeWorkingStateKeys.clear();
    this.workingStateByWorktree.clear();
    this.workingStateCacheLoaded = false;
    this.worktreePathByThreadKey.clear();
    this.prRefreshContextByThreadKey.clear();
    await disposeDesktopBackendRegistry();
    await this.threadMigrationService?.dispose();
    this.threadMigrationService = null;
  }

  private getPrFetcher(): GithubPrFetcher {
    if (!this.prFetcher) {
      this.prFetcher = new GithubPrFetcher({
        graphqlClient: this.getPrGraphqlClient(),
      });
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
        getCurrentPr: (prKey) => this.prStatusRegistry.get(prKey)?.pr,
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

  private getPrStatusWatchCoordinator(): PrStatusWatchCoordinator {
    if (!this.prStatusWatchCoordinator) {
      this.prStatusWatchCoordinator = new PrStatusWatchCoordinator({
        store: this.getOverlayStore(),
        registry: getDesktopBackendRegistry(),
        isBackgroundPollingEnabled: () => this.backgroundPrPollingEnabled,
      });
    }
    return this.prStatusWatchCoordinator;
  }

  private getFocusedDiffService(): FocusedDiffService {
    if (this.focusedDiffService) {
      return this.focusedDiffService;
    }

    this.focusedDiffService = new FocusedDiffService({
      client: {
        generateObject: async (request) => {
          const result = await getDesktopBackendRegistry().generateStructuredObject(request);
          if (result.status !== "ok") {
            throw new Error(result.reason);
          }
          return { object: result.object };
        },
      },
    });
    return this.focusedDiffService;
  }
}

function isFreshDirectoryGitStatusCacheEntry(
  entry: DirectoryGitStatusCacheEntry,
): boolean {
  return Date.now() - entry.fetchedAt < DIRECTORY_GIT_STATUS_CACHE_MAX_AGE_MS;
}

function isFreshWorktreeWorkingStateCacheEntry(
  entry: WorktreeGitWorkingStateCacheEntry,
): boolean {
  return Date.now() - entry.fetchedAt < WORKTREE_WORKING_STATE_CACHE_MAX_AGE_MS;
}

async function resolvePrimaryThreadRepoKey(
  thread: Pick<
    NavigationSnapshot["threads"][number],
    "gitOriginUrl" | "linkedDirectories"
  >,
  resolutionByPath = new Map<string, Promise<string | undefined>>(),
): Promise<string | undefined> {
  const origin = thread.gitOriginUrl
    ? parseGitHubRemote(thread.gitOriginUrl)
    : undefined;
  if (origin) return buildPrRepositoryKey(origin.host, origin.owner, origin.repo);

  const primaryDirectory = thread.linkedDirectories[0];
  const primaryPath = primaryDirectory
    ? resolvePullRequestDirectoryPath(primaryDirectory)
    : undefined;
  if (!primaryPath) return undefined;
  const existing = resolutionByPath.get(primaryPath);
  if (existing) return await existing;
  const resolution = resolveGitHubRepoForDirectory(primaryPath)
    .then((resolved) => resolved
      ? buildPrRepositoryKey(resolved.host, resolved.owner, resolved.repo)
      : undefined);
  resolutionByPath.set(primaryPath, resolution);
  return await resolution;
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

function resolvePullRequestDirectoryPath(
  directory: AppServerThreadSummary["linkedDirectories"][number],
): string | undefined {
  const candidate =
    directory.kind === "worktree"
      ? directory.worktreePath ?? directory.path
      : directory.path;
  return candidate?.trim() || undefined;
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

const appServerService = new DesktopAppServerService();
const navigationSnapshotTransport = new NavigationSnapshotTransport();

/** Sender ids that already have a destroyed-listener reaping their PR focus. */
const prPollingFocusCleanupSenderIds = new Set<number>();

let unsubscribeWorkingStateEvents: (() => void) | undefined;

export function registerAppServerIpcHandlers(): void {
  // Refresh a thread's working-state chips when the agent finishes a turn
  // or a git-mutating command in its worktree. Re-registering tears the
  // previous subscription down first so repeated calls don't stack listeners.
  unsubscribeWorkingStateEvents?.();
  unsubscribeWorkingStateEvents = getDesktopBackendRegistry().onEvent((event) => {
    appServerService.handleAgentEventForWorkingState(event);
    appServerService.handleAgentEventForPrAttachments(event);
  });
  getDesktopBackendRegistry().setThreadPullRequestStatusToolHandler(
    async (args, context) =>
      await appServerService.checkThreadPullRequestStatusForTool(args, context),
  );
  getDesktopBackendRegistry().setThreadPullRequestCanonicalizer(
    async (prs) =>
      await appServerService.canonicalizeStoredPullRequests(prs),
  );
  getDesktopBackendRegistry().setLocalPullRequestAuthorityResolver((prKey) =>
    appServerService.isPullRequestLocallyMonitored(prKey)
  );
  getDesktopBackendRegistry().setThreadPullRequestWatchToolHandler(
    async (args) => await appServerService.watchThreadPullRequestForTool(args),
  );
  getDesktopBackendRegistry().setDirectoryGitStatusWriter(
    async (params) => await appServerService.writeDirectoryGitStatusEntry(params),
  );
  getDesktopBackendRegistry().setThreadPullRequestDetachHandler(
    async (request) => await appServerService.detachThreadPullRequest(request),
  );
  getDesktopBackendRegistry().setThreadPrAutoDispatchHandler({
    preferenceChanged: async (request) =>
      await appServerService.handleThreadPrAutoDispatchPreference(request),
    preferencesChanged: async (requests) =>
      await appServerService.handleThreadPrAutoDispatchPreferences(requests),
    cancelPending: async (request) =>
      await appServerService.cancelThreadPrAutoDispatch(request),
    sendPendingNow: async (request) =>
      await appServerService.sendThreadPrAutoDispatchNow(request),
    inspect: async (request, context) =>
      await appServerService.getThreadPullRequestAutomationStatus(
        request,
        context,
      ),
  });

  ipcMain.removeHandler(APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL);
  ipcMain.handle(
    APP_SERVER_GET_PR_AUTO_DISPATCH_BUDGET_STATUS_CHANNEL,
    async (): Promise<PrAutoDispatchBudgetStatus> =>
      await appServerService.getPrAutoDispatchBudgetStatus(),
  );
  ipcMain.removeHandler(APP_SERVER_RESUME_PR_AUTO_DISPATCH_BUDGET_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RESUME_PR_AUTO_DISPATCH_BUDGET_CHANNEL,
    async (): Promise<PrAutoDispatchBudgetStatus> =>
      await appServerService.resumePrAutoDispatchBudget(),
  );

  ipcMain.removeHandler(APP_SERVER_LIST_SKILLS_CHANNEL);
  ipcMain.handle(
    APP_SERVER_LIST_SKILLS_CHANNEL,
    async (
      _event,
      request?: AppServerListSkillsRequest,
    ): Promise<AppServerListSkillsResponse> => {
      return await appServerService.listSkills(request);
    }
  );
  ipcMain.removeHandler(APP_SERVER_LIST_THREADS_CHANNEL);
  ipcMain.handle(
    APP_SERVER_LIST_THREADS_CHANNEL,
    async (
      _event,
      request?: AppServerListThreadsRequest
    ): Promise<AppServerListThreadsResponse> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:listThreads",
        detail: {
          archived: Boolean(request?.archived),
          backend: request?.backend ?? null,
        },
        operation: async () => await appServerService.listThreads(request),
      });
    }
  );
  ipcMain.removeHandler(THREAD_SEARCH_CHANNEL);
  ipcMain.handle(
    THREAD_SEARCH_CHANNEL,
    async (
      _event,
      request?: ThreadSearchRequest,
    ): Promise<ThreadSearchResponse> => {
      return await appServerService.searchThreads(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_READ_THREAD_CHANNEL);
  ipcMain.handle(
    APP_SERVER_READ_THREAD_CHANNEL,
    async (
      _event,
      request: AppServerReadThreadRequest
    ): Promise<AppServerReadThreadResponse> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:readThread",
        detail: {
          backend: request.backend,
          threadId: request.threadId,
        },
        operation: async () => await appServerService.readThread(request),
      });
    }
  );
  ipcMain.removeHandler(APP_SERVER_ANALYZE_THREAD_TOOL_HISTORY_CHANNEL);
  ipcMain.handle(
    APP_SERVER_ANALYZE_THREAD_TOOL_HISTORY_CHANNEL,
    async (
      _event,
      request: AnalyzeThreadToolHistoryRequest,
    ): Promise<AnalyzeThreadToolHistoryResponse> =>
      await appServerService.analyzeThreadToolHistory(request),
  );
  ipcMain.removeHandler(APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL);
  ipcMain.handle(
    APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL,
    async (
      _event,
      request: GetThreadFileDiffRequest,
    ): Promise<GetThreadFileDiffResponse> => {
      const diff =
        getLiveThreadFileDiff(request.ref) ??
        getThreadReplayFileDiff(request.ref);
      return diff === undefined
        ? { omittedReason: "Diff is no longer available for this thread entry." }
        : { diff };
    },
  );
  ipcMain.removeHandler(APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL);
  ipcMain.handle(
    APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL,
    async (
      _event,
      request: PersistThreadUsageActivityRequest,
    ): Promise<PersistThreadUsageActivityResponse> => {
      return await appServerService.persistThreadUsageActivity(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_THREAD_CHANNEL);
  ipcMain.handle(
    APP_SERVER_ARCHIVE_THREAD_CHANNEL,
    async (
      _event,
      request: ArchiveThreadRequest,
    ): Promise<ArchiveThreadResponse> => {
      return await appServerService.archiveThread(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_RESOLVE_MISSING_CODEX_THREADS_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RESOLVE_MISSING_CODEX_THREADS_CHANNEL,
    async (
      _event,
      request: ResolveMissingCodexThreadsRequest,
    ): Promise<ResolveMissingCodexThreadsResponse> => {
      return await appServerService.resolveMissingCodexThreads(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_RESTORE_THREAD_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RESTORE_THREAD_CHANNEL,
    async (
      _event,
      request: RestoreThreadRequest,
    ): Promise<RestoreThreadResponse> => {
      return await appServerService.restoreThread(request);
    },
  );
  ipcMain.removeHandler(THREAD_MIGRATION_LIST_SOURCES_CHANNEL);
  ipcMain.handle(
    THREAD_MIGRATION_LIST_SOURCES_CHANNEL,
    async (): Promise<ListThreadMigrationSourcesResponse> => {
      return await appServerService.listThreadMigrationSources();
    },
  );
  ipcMain.removeHandler(THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL);
  ipcMain.handle(
    THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL,
    async (
      _event,
      request: ListThreadMigrationSourceThreadsRequest,
    ): Promise<ListThreadMigrationSourceThreadsResponse> => {
      return await appServerService.listThreadMigrationSourceThreads(request);
    },
  );
  ipcMain.removeHandler(THREAD_MIGRATION_START_CHANNEL);
  ipcMain.handle(
    THREAD_MIGRATION_START_CHANNEL,
    async (
      _event,
      request: StartThreadMigrationRequest,
    ): Promise<StartThreadMigrationResponse> => {
      return await appServerService.startThreadMigration(request);
    },
  );
  ipcMain.removeHandler(THREAD_MIGRATION_RETRY_CHANNEL);
  ipcMain.handle(
    THREAD_MIGRATION_RETRY_CHANNEL,
    async (
      _event,
      request: RetryThreadMigrationRequest,
    ): Promise<StartThreadMigrationResponse> => {
      return await appServerService.retryThreadMigration(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_WORKTREE_CHANNEL);
  ipcMain.handle(
    APP_SERVER_ARCHIVE_WORKTREE_CHANNEL,
    async (
      _event,
      request: ArchiveWorktreeRequest,
    ): Promise<ArchiveWorktreeResponse> => {
      return await appServerService.archiveWorktree(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_RESTORE_WORKTREE_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RESTORE_WORKTREE_CHANNEL,
    async (
      _event,
      request: RestoreWorktreeRequest,
    ): Promise<RestoreWorktreeResponse> => {
      return await appServerService.restoreWorktree(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL);
  ipcMain.handle(
    APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL,
    async (
      _event,
      request: HandoffThreadWorkspaceRequest,
    ): Promise<HandoffThreadWorkspaceResponse> => {
      return await appServerService.handoffThreadWorkspace(request);
    },
  );
  ipcMain.removeHandler(APP_SERVER_RENAME_THREAD_CHANNEL);
  ipcMain.handle(
    APP_SERVER_RENAME_THREAD_CHANNEL,
    async (
      _event,
      request: RenameThreadRequest,
    ): Promise<RenameThreadResponse> => {
      return await appServerService.renameThread(request);
    },
  );
  ipcMain.removeHandler(FOCUSED_DIFF_ANALYZE_CHANNEL);
  ipcMain.handle(
    FOCUSED_DIFF_ANALYZE_CHANNEL,
    async (
      _event,
      request: FocusedDiffAnalysisRequest
    ): Promise<FocusedDiffAnalysisResponse> => {
      return await appServerService.analyzeFocusedDiff(request);
    }
  );
  ipcMain.removeHandler(NAVIGATION_SNAPSHOT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SNAPSHOT_CHANNEL,
    async (
      _event,
      request?:
        | GetNavigationSnapshotRequest
        | GetNavigationSnapshotTransportRequest,
    ): Promise<NavigationSnapshot | NavigationSnapshotTransportResponse> => {
      const transportRequest =
        request && "transport" in request ? request : undefined;
      return await timeStartupProfileOperation({
        type: "ipc-main:getNavigationSnapshot",
        detail: {
          forceRefresh: Boolean(request?.forceRefresh),
          transport: transportRequest?.transport.protocol ?? null,
        },
        operation: async () => {
          if (!transportRequest) {
            return await appServerService.getNavigationSnapshot(request);
          }
          const { transport, ...snapshotRequest } = transportRequest;
          const snapshot = await appServerService.getNavigationSnapshot(
            snapshotRequest,
          );
          return navigationSnapshotTransport.encode({
            baseRevision: transport.baseRevision,
            request: snapshotRequest,
            snapshot,
          });
        },
      });
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_BROWSE_MODE_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_BROWSE_MODE_CHANNEL,
    async (
      _event,
      request: SetNavigationBrowseModeRequest,
    ): Promise<SetNavigationBrowseModeResponse> => {
      return await appServerService.setNavigationBrowseMode(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_MARK_THREAD_SEEN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_MARK_THREAD_SEEN_CHANNEL,
    async (
      _event,
      request: MarkThreadSeenRequest,
    ): Promise<MarkThreadSeenResponse> => {
      return await appServerService.markThreadSeen(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_REACTION_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_REACTION_CHANNEL,
    async (
      _event,
      request: SetThreadReactionRequest,
    ): Promise<SetThreadReactionResponse> => {
      return await appServerService.setThreadReaction(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_TOOL_INCIDENT_NOTICE_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_TOOL_INCIDENT_NOTICE_CHANNEL,
    async (
      _event,
      request: SetThreadToolIncidentNoticeRequest,
    ): Promise<SetThreadToolIncidentNoticeResponse> => {
      return await appServerService.setThreadToolIncidentNotice(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_ACKNOWLEDGE_THREAD_SPEND_ALERT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_ACKNOWLEDGE_THREAD_SPEND_ALERT_CHANNEL,
    async (
      _event,
      request: AcknowledgeThreadSpendAlertRequest,
    ): Promise<AcknowledgeThreadSpendAlertResponse> => {
      return await appServerService.acknowledgeThreadSpendAlert(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_PIN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_PIN_CHANNEL,
    async (
      _event,
      request: SetThreadPinRequest,
    ): Promise<SetThreadPinResponse> => {
      return await appServerService.setThreadPin(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_AGENT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_AGENT_CHANNEL,
    async (
      _event,
      request: SetThreadAgentRequest,
    ): Promise<SetThreadAgentResponse> => {
      return await appServerService.setThreadAgent(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REORDER_THREAD_PINS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REORDER_THREAD_PINS_CHANNEL,
    async (
      _event,
      request: ReorderThreadPinsRequest,
    ): Promise<ReorderThreadPinsResponse> => {
      return await appServerService.reorderThreadPins(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_ADD_REMOTE_THREAD_PIN_CHANNEL,
    async (
      _event,
      request: AddRemoteThreadPinRequest,
    ): Promise<AddRemoteThreadPinResponse> => {
      return await appServerService.addRemoteThreadPin(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REMOVE_REMOTE_THREAD_PIN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REMOVE_REMOTE_THREAD_PIN_CHANNEL,
    async (
      _event,
      request: RemoveRemoteThreadPinRequest,
    ): Promise<RemoveRemoteThreadPinResponse> => {
      return await appServerService.removeRemoteThreadPin(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_REMOTE_THREAD_LOCAL_PIN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_REMOTE_THREAD_LOCAL_PIN_CHANNEL,
    async (
      _event,
      request: SetRemoteThreadLocalPinRequest,
    ): Promise<SetRemoteThreadLocalPinResponse> => {
      return await appServerService.setRemoteThreadLocalPin(request);
    },
  );
  ipcMain.removeHandler(FEDERATION_JUMP_SEARCH_CHANNEL);
  ipcMain.handle(
    FEDERATION_JUMP_SEARCH_CHANNEL,
    async (
      _event,
      request: FederationJumpSearchRequest,
    ): Promise<FederationJumpSearchResponse> => {
      return await appServerService.jumpSearchRemoteThreads(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_PARENT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_THREAD_PARENT_CHANNEL,
    async (
      _event,
      request: SetThreadParentRequest,
    ): Promise<SetThreadParentResponse> => {
      return await appServerService.setThreadParent(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_UPDATE_SUBTHREAD_ORDER_CHANNEL);
  ipcMain.handle(
    NAVIGATION_UPDATE_SUBTHREAD_ORDER_CHANNEL,
    async (
      _event,
      request: UpdateSubthreadOrderRequest,
    ): Promise<UpdateSubthreadOrderResponse> => {
      return await appServerService.updateSubthreadOrder(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_SUBTHREADS_COLLAPSED_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_SUBTHREADS_COLLAPSED_CHANNEL,
    async (
      _event,
      request: SetSubthreadsCollapsedRequest,
    ): Promise<SetSubthreadsCollapsedResponse> => {
      return await appServerService.setSubthreadsCollapsed(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_DIRECTORY_PIN_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_DIRECTORY_PIN_CHANNEL,
    async (
      _event,
      request: SetDirectoryPinRequest,
    ): Promise<SetDirectoryPinResponse> => {
      return await appServerService.setDirectoryPin(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REORDER_DIRECTORY_PINS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REORDER_DIRECTORY_PINS_CHANNEL,
    async (
      _event,
      request: ReorderDirectoryPinsRequest,
    ): Promise<ReorderDirectoryPinsResponse> => {
      return await appServerService.reorderDirectoryPins(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_DIRECTORY_THREADS_COLLAPSED_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_DIRECTORY_THREADS_COLLAPSED_CHANNEL,
    async (
      _event,
      request: SetDirectoryThreadsCollapsedRequest,
    ): Promise<SetDirectoryThreadsCollapsedResponse> => {
      return await appServerService.setDirectoryThreadsCollapsed(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REFRESH_THREAD_PRS_CHANNEL,
    async (
      event,
      request: RefreshThreadPullRequestsRequest,
    ): Promise<RefreshThreadPullRequestsResponse> => {
      // Defense in depth behind the renderer-side guard: a remote
      // federation window's PR lookups belong to the owning instance.
      // Running them here would use THIS machine's paths and GitHub
      // credentials against a remote thread id. Throw (renderer refresh
      // paths swallow errors) rather than return an empty result a
      // caller might diff against snapshot PRs and loop on.
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error(
          "PR lookups for remote threads run on the owning instance.",
        );
      }
      return await timeStartupProfileOperation({
        type: "ipc-main:refreshThreadPullRequests",
        detail: {
          backend: request.backend ?? null,
          directoryPathCount: request.directoryPaths.length,
          threadId: request.threadId,
          trigger: request.trigger ?? null,
        },
        operation: async () =>
          await appServerService.refreshThreadPullRequests(request),
      });
    },
  );
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_GIT_WORKING_STATE_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REFRESH_THREAD_GIT_WORKING_STATE_CHANNEL,
    async (
      event,
      request: RefreshThreadGitWorkingStateRequest,
    ): Promise<RefreshThreadGitWorkingStateResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error(
          "Git working-state refreshes for remote threads run on the owning instance.",
        );
      }
      return await appServerService.refreshThreadGitWorkingState(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_PR_POLLING_FOCUS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_PR_POLLING_FOCUS_CHANNEL,
    async (event, request: SetPullRequestPollingFocusRequest): Promise<void> => {
      // A federation window's selection is a remote thread key — it would
      // never match a local poll target, so don't track it at all.
      if (isFederationWindowWebContents(event?.sender)) {
        return;
      }
      const sender = event?.sender;
      if (!sender) {
        appServerService.setPullRequestPollingFocus(request);
        return;
      }
      appServerService.setPullRequestPollingFocus(request, sender.id);
      // Focus entries are per-window; reap this window's entry when it
      // closes so its threads fall back out of the fast tier.
      if (!prPollingFocusCleanupSenderIds.has(sender.id)) {
        prPollingFocusCleanupSenderIds.add(sender.id);
        sender.once("destroyed", () => {
          prPollingFocusCleanupSenderIds.delete(sender.id);
          appServerService.clearPullRequestPollingFocusForSender(sender.id);
        });
      }
    },
  );
  ipcMain.removeHandler(NAVIGATION_DETACH_THREAD_PR_CHANNEL);
  ipcMain.handle(
    NAVIGATION_DETACH_THREAD_PR_CHANNEL,
    async (
      event,
      request: DetachThreadPullRequestRequest,
    ): Promise<DetachThreadPullRequestResponse> => {
      // Defense in depth behind renderer stamping: a federation window's
      // detach must carry a remote target so it routes to the owning
      // instance instead of polluting this machine's overlay store.
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Detaching a pull request for a remote thread must target the owning instance.",
        );
      }
      return await appServerService.detachThreadPullRequest(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL,
    async (
      _event,
      request: RefreshDirectoryGitStatusesRequest,
    ): Promise<RefreshDirectoryGitStatusesResponse> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:refreshDirectoryGitStatuses",
        detail: {
          force: Boolean(request.force),
          keyCount: request.directoryKeys.length,
        },
        operation: async () =>
          await appServerService.refreshDirectoryGitStatusesForKeys(request),
      });
    },
  );
  ipcMain.removeHandler(NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL,
    async (
      _event,
      request: ResolveEditCommitStatesRequest,
    ): Promise<ResolveEditCommitStatesResponse> => {
      return await appServerService.resolveEditCommitStates(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_LIST_WORKTREE_OTHER_CHANGES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_LIST_WORKTREE_OTHER_CHANGES_CHANNEL,
    async (
      _event,
      request: ListWorktreeOtherChangesRequest,
    ): Promise<ListWorktreeOtherChangesResponse> => {
      return await appServerService.listWorktreeOtherChanges(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_GET_WORKTREE_OTHER_CHANGE_DIFF_CHANNEL);
  ipcMain.handle(
    NAVIGATION_GET_WORKTREE_OTHER_CHANGE_DIFF_CHANNEL,
    async (
      _event,
      request: GetWorktreeOtherChangeDiffRequest,
    ): Promise<GetWorktreeOtherChangeDiffResponse> => {
      return await appServerService.getWorktreeOtherChangeDiff(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_LIST_WORKTREE_UNPUBLISHED_COMMITS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_LIST_WORKTREE_UNPUBLISHED_COMMITS_CHANNEL,
    async (
      event,
      request: ListWorktreeUnpublishedCommitsRequest,
    ): Promise<ListWorktreeUnpublishedCommitsResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Unpublished commit reads for a remote thread must target the owning instance.",
        );
      }
      return await appServerService.listWorktreeUnpublishedCommits(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_GET_WORKTREE_UNPUBLISHED_COMMIT_DIFF_CHANNEL);
  ipcMain.handle(
    NAVIGATION_GET_WORKTREE_UNPUBLISHED_COMMIT_DIFF_CHANNEL,
    async (
      event,
      request: GetWorktreeUnpublishedCommitDiffRequest,
    ): Promise<GetWorktreeUnpublishedCommitDiffResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Unpublished commit reads for a remote thread must target the owning instance.",
        );
      }
      return await appServerService.getWorktreeUnpublishedCommitDiff(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_GET_GH_STATUS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_GET_GH_STATUS_CHANNEL,
    async (_event, request: GetGhStatusRequest | undefined): Promise<GhStatus> => {
      return await timeStartupProfileOperation({
        type: "ipc-main:getGhStatus",
        operation: async () => await appServerService.getGhStatus(request ?? {}),
      });
    },
  );
  ipcMain.removeHandler(NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL,
    async (
      event,
      request: EnsureDirectoryLaunchpadRequest,
    ): Promise<EnsureDirectoryLaunchpadResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote launchpads must load filesystem metadata from the owning instance.",
        );
      }
      return await appServerService.ensureDirectoryLaunchpad(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL,
    async (
      _event,
      request: UpdateDirectoryLaunchpadRequest,
    ): Promise<UpdateDirectoryLaunchpadResponse> => {
      return await appServerService.updateDirectoryLaunchpad(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_SET_ELIGIBLE_THREADS_PR_AUTO_DISPATCH_CHANNEL);
  ipcMain.handle(
    NAVIGATION_SET_ELIGIBLE_THREADS_PR_AUTO_DISPATCH_CHANNEL,
    async (
      _event,
      request: SetEligibleThreadsPrAutoDispatchRequest,
    ): Promise<SetEligibleThreadsPrAutoDispatchResponse> => {
      return await appServerService.setEligibleThreadsPrAutoDispatch(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL,
    async (
      _event,
      request: ResetDirectoryLaunchpadRequest,
    ): Promise<ResetDirectoryLaunchpadResponse> => {
      return await appServerService.resetDirectoryLaunchpad(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.handle(
    NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL,
    async (event): Promise<PickDirectoryFromDiskResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        return { canceled: true };
      }
      // Find the window that dispatched the IPC so the system "Choose
      // folder" dialog anchors to it as a sheet on macOS. Falls back to
      // the focused window inside `pickDirectoryFromDisk`.
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      return await appServerService.pickDirectoryFromDisk(
        senderWindow ?? undefined,
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_PICK_FILE_FROM_DISK_CHANNEL);
  ipcMain.handle(
    NAVIGATION_PICK_FILE_FROM_DISK_CHANNEL,
    async (event): Promise<PickFileFromDiskResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        return { canceled: true };
      }
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      return await appServerService.pickFileFromDisk(
        senderWindow ?? undefined,
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_PICK_REFERENCE_FROM_DISK_CHANNEL);
  ipcMain.handle(
    NAVIGATION_PICK_REFERENCE_FROM_DISK_CHANNEL,
    async (event): Promise<PickReferenceFromDiskResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        return { canceled: true };
      }
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      return await appServerService.pickReferenceFromDisk(
        senderWindow ?? undefined,
      );
    },
  );
  ipcMain.removeHandler(NAVIGATION_INSPECT_PDF_REFERENCE_PATHS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_INSPECT_PDF_REFERENCE_PATHS_CHANNEL,
    async (
      event,
      request: InspectPdfReferencePathsRequest,
    ): Promise<InspectPdfReferencePathsResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error(
          "Remote file references cannot be inspected on the viewing instance.",
        );
      }
      return inspectPdfReferencePaths(request.paths ?? []);
    },
  );
  ipcMain.removeHandler(NAVIGATION_RENDER_COMPOSER_PDF_PREVIEW_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RENDER_COMPOSER_PDF_PREVIEW_CHANNEL,
    async (
      event,
      request: RenderComposerPdfPreviewRequest,
    ): Promise<RenderComposerPdfPreviewResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error(
          "Remote file previews cannot be rendered on the viewing instance.",
        );
      }
      return await renderExplicitComposerPdfPreview(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_LIST_RECENT_FILE_REFERENCES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_LIST_RECENT_FILE_REFERENCES_CHANNEL,
    async (
      event,
      request: ListRecentFileReferencesRequest = {},
    ): Promise<ListRecentFileReferencesResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote recent files must be loaded from the owning instance.",
        );
      }
      return await appServerService.listRecentFileReferences(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_RECORD_RECENT_FILE_REFERENCES_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RECORD_RECENT_FILE_REFERENCES_CHANNEL,
    async (
      event,
      request: RecordRecentFileReferencesRequest,
    ): Promise<void> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote recent files must be recorded on the owning instance.",
        );
      }
      await appServerService.recordRecentFileReferences(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_LIST_MODEL_SETTINGS_RECENTS_CHANNEL);
  ipcMain.handle(
    NAVIGATION_LIST_MODEL_SETTINGS_RECENTS_CHANNEL,
    async (
      event,
      request: ListModelSettingsRecentsRequest,
    ): Promise<ListModelSettingsRecentsResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote model settings recents must be loaded from the owning instance.",
        );
      }
      return await appServerService.listModelSettingsRecents(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_RECORD_MODEL_SETTINGS_RECENT_CHANNEL);
  ipcMain.handle(
    NAVIGATION_RECORD_MODEL_SETTINGS_RECENT_CHANNEL,
    async (
      event,
      request: RecordModelSettingsRecentRequest,
    ): Promise<void> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote model settings recents must be recorded on the owning instance.",
        );
      }
      await appServerService.recordModelSettingsRecent(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.handle(
    NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL,
    async (
      event,
      request: RegisterDirectoryFromDiskRequest,
    ): Promise<RegisterDirectoryFromDiskResponse> => {
      if (isFederationWindowWebContents(event?.sender)) {
        throw new Error(
          "Remote windows cannot register directories from the viewing instance.",
        );
      }
      return await appServerService.registerDirectoryFromDisk(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_ATTACH_DIRECTORY_TO_THREAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_ATTACH_DIRECTORY_TO_THREAD_CHANNEL,
    async (
      event,
      request: AttachDirectoryToThreadRequest,
    ): Promise<AttachDirectoryToThreadResponse> => {
      if (
        isFederationWindowWebContents(event?.sender)
        && !(
          request.federationTarget
          && isRemoteFederationTarget(request.federationTarget)
        )
      ) {
        throw new Error(
          "Remote directory attachments must target the owning instance.",
        );
      }
      return await appServerService.attachDirectoryToThread(request);
    },
  );
  ipcMain.removeHandler(NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL);
  ipcMain.handle(
    NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL,
    async (
      _event,
      request: DetachDirectoryFromThreadRequest,
    ): Promise<DetachDirectoryFromThreadResponse> => {
      return await appServerService.detachDirectoryFromThread(request);
    },
  );
}

export async function disposeAppServerIpcHandlers(): Promise<void> {
  ipcMain.removeHandler(APP_SERVER_LIST_SKILLS_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_LIST_THREADS_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_READ_THREAD_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_ANALYZE_THREAD_TOOL_HISTORY_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_GET_THREAD_FILE_DIFF_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_PERSIST_THREAD_USAGE_ACTIVITY_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_THREAD_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RESOLVE_MISSING_CODEX_THREADS_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RESTORE_THREAD_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_LIST_SOURCES_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_LIST_SOURCE_THREADS_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_START_CHANNEL);
  ipcMain.removeHandler(THREAD_MIGRATION_RETRY_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_ARCHIVE_WORKTREE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RESTORE_WORKTREE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_HANDOFF_THREAD_WORKSPACE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_RENAME_THREAD_CHANNEL);
  ipcMain.removeHandler(THREAD_SEARCH_CHANNEL);
  ipcMain.removeHandler(FOCUSED_DIFF_ANALYZE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SNAPSHOT_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_BROWSE_MODE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_MARK_THREAD_SEEN_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_REACTION_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_THREAD_AGENT_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_PRS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REFRESH_THREAD_GIT_WORKING_STATE_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_DETACH_THREAD_PR_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REFRESH_DIRECTORY_GIT_STATUSES_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_RESOLVE_EDIT_COMMIT_STATES_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_LIST_WORKTREE_OTHER_CHANGES_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_GET_WORKTREE_OTHER_CHANGE_DIFF_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_LIST_WORKTREE_UNPUBLISHED_COMMITS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_GET_WORKTREE_UNPUBLISHED_COMMIT_DIFF_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_GET_GH_STATUS_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_ENSURE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_UPDATE_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_SET_ELIGIBLE_THREADS_PR_AUTO_DISPATCH_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_RESET_DIRECTORY_LAUNCHPAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_PICK_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_REGISTER_DIRECTORY_FROM_DISK_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_RENDER_COMPOSER_PDF_PREVIEW_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_ATTACH_DIRECTORY_TO_THREAD_CHANNEL);
  ipcMain.removeHandler(NAVIGATION_DETACH_DIRECTORY_FROM_THREAD_CHANNEL);
  unsubscribeWorkingStateEvents?.();
  unsubscribeWorkingStateEvents = undefined;
  navigationSnapshotTransport.clear();
  const registry = getExistingDesktopBackendRegistry();
  registry?.setThreadPullRequestStatusToolHandler(undefined);
  registry?.setThreadPullRequestCanonicalizer(undefined);
  registry?.setLocalPullRequestAuthorityResolver(undefined);
  registry?.setThreadPullRequestWatchToolHandler(undefined);
  registry?.setDirectoryGitStatusWriter(undefined);
  registry?.setThreadPrAutoDispatchHandler(undefined);
  registry?.setThreadPullRequestDetachHandler(undefined);
  await appServerService.close();
}

export { APP_SERVER_LIST_THREADS_CHANNEL };
