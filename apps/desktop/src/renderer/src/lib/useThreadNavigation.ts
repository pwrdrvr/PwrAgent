import { readNavigationQueryRange } from "./read-navigation-query-range";
import { useBoundedNavigationWindow } from "./useBoundedNavigationWindow";
import { readNavigationArchiveGroup, type NavigationArchiveMember } from "./navigation-archive-group";
import { useNavigationLaunchpadConfiguration } from "./useNavigationLaunchpadConfiguration";
import { navigationQueryEventRequiresRefresh } from "./navigation-query-events";
import type { ComposerDraftStore } from "../features/composer/useComposerDraftStore";
import { loadedThreadRows, loadedDirectoryRows, indexLoadedThreadRows, indexLoadedDirectoryRows, type NavigationLoadedRows, type NavigationPresentedThread, type NavigationDirectoryView as NavigationDirectorySummary } from "./navigation-loaded-rows";
import { readNavigationActionDetail, readNavigationActionThread, resolveNavigationActionGroupRoot } from "./navigation-action-authority";
import { applyLaunchpadEnvironmentSetupProgress, type LaunchpadEnvironmentSetupProgress } from "./launchpad-setup-progress";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  AppServerBackendKind,
  AppServerCollaborationModeRequest,
  AppServerRenamedTitleSource,
  AppServerReviewTarget,
  AppServerThreadImagePart,
  AppServerThreadStatus,
  AppServerTurnInputItem,
  ArchiveThreadCleanupResult,
  CodexThreadEnvironmentRuntime,
  FederationRemoteTarget,
  FederationTarget,
  HandoffThreadWorkspaceRequest,
  LinkedDirectorySummary,
  NavigationBrowseMode,
  NavigationDirectoryGitStatus,
  NavigationDirectoryGitStatusUpdatedNotification,
  NavigationLaunchpadDefaults,
  NavigationLaunchpadDraft,
  NavigationRelativePinMove,
  FederationPeerSummary,
  NavigationThreadGitWorkingStateUpdatedNotification,
  NavigationThreadSummary,
  PrSummary,
  ThreadAgentMetadata,
  ThreadExecutionMode,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import {
  AGENT_PERSONA_INSTRUCTIONS_LINE_GUIDANCE,
  applyNavigationLaunchpadProviderSettingsPatch,
  buildPinnedRanks,
  buildPullRequestStatusKey,
  buildThreadIdentityKey,
  classifyDirectory,
  parseOwnedComposerScopeKey,
  comparePinnedThreads,
  compareThreadsByCreatedAtDesc,
  DEFAULT_NAVIGATION_BROWSE_MODE,
  federatedThreadIdentityKey,
  isRemoteFederationTarget,
  isSubthreadLaunchpadKey,
  normalizeNavigationBrowseMode,
  normalizeRenamedTitleSource,
  resolveThreadParentKey,
  shortenDerivedThreadTitle,
  sortSubthreadSummaries,
} from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { useNavigationDirectoryDisclosure, type NavigationDirectoryDisclosure } from "./useNavigationDirectoryDisclosure";
import { useNavigationSelectedDetail } from "./useNavigationSelectedDetail";
import { navigationIdentityFromThreadKey } from "./navigation-query-state";
import type { ThreadActionErrorKind } from "../features/notifications/thread-action-error-notice";
import { fileLabelFromPath } from "./directory-references";
import {
  readRendererFederationLabel,
  readRendererFederationTarget,
} from "./federation-window";

import { resolveThreadWorkingStatePath } from "./thread-working-state-path";
import {
  agentEventMatchesThread,
  agentEventThreadIdentityKey,
  federationTargetsEqual,
  threadSupportsFederationCapability,
  threadSummaryIdentityKey,
} from "./federated-thread-events";
import {
  buildSubthreadLaunchpadKey,
  getParentThreadIdFromSubthreadLaunchpadKey,
  type ThreadWorkspaceMode,
} from "./subthread-launchpads";

export type BrowseMode = NavigationBrowseMode;
export type { ThreadWorkspaceMode } from "./subthread-launchpads";

export type ArchiveThreadNotice = {
  id: string;
  title: string;
  message: string;
  detail?: string;
};

export type ArchiveThreadOptions = {
  includeSubthreads?: boolean;
};

export type PendingForkEnvironmentSetup = {
  backend: AppServerBackendKind;
  command: string;
  cwd?: string;
  directoryKey: string;
  directoryLabel: string;
  environmentId: string;
  environmentName: string;
};

export type CreatingThreadState = {
  backend: AppServerBackendKind;
  executionMode: ThreadExecutionMode;
  pendingForkEnvironmentSetup?: PendingForkEnvironmentSetup;
};

const ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY = "workspace:new-thread";
const ROOT_NEW_THREAD_WORKSPACE_LABEL = "Workspaces";
const FEDERATED_LAUNCHPAD_SELECTION_PREFIX = "federated-launchpad:";
const NAVIGATION_BACKGROUND_REFRESH_INTERVAL_MS = 5 * 60_000;
const NAVIGATION_BACKGROUND_REFRESH_IDLE_AFTER_MS = 30 * 60_000;
const NAVIGATION_FOCUS_REFRESH_MIN_INTERVAL_MS = 60_000;
const NAVIGATION_ACTIVITY_EVENTS = [
  "input",
  "keydown",
  "paste",
  "pointerdown",
] as const;

const DEFAULT_BROWSE_MODE = DEFAULT_NAVIGATION_BROWSE_MODE;
const normalizeBrowseMode = normalizeNavigationBrowseMode;

function readBridgedBrowseMode(): BrowseMode {
  if (typeof window === "undefined") {
    return DEFAULT_BROWSE_MODE;
  }
  const bridged = (window as unknown as {
    __pwragentNavigationPreferences?: { browseMode?: unknown };
  }).__pwragentNavigationPreferences;
  return normalizeBrowseMode(bridged?.browseMode);
}

function isRendererViewForeground(): boolean {
  if (typeof document === "undefined") {
    return true;
  }

  if (document.visibilityState !== "visible") {
    return false;
  }

  return typeof document.hasFocus !== "function" ? true : document.hasFocus();
}

type NavigationState = {
  loading: boolean;
  refreshing: boolean;
  error?: string;
  rows?: NavigationLoadedRows;
  startupSelectionSettled?: boolean;
};

type NavigationRefreshOptions = {
  forceRefresh?: boolean;
  refreshMode?: "active-recent" | "full";
};

type FederatedLaunchpadSession = {
  directories: NavigationDirectorySummary[];
  directory: NavigationDirectorySummary;
  launchpad: NavigationLaunchpadDraft;
  target: FederationRemoteTarget;
};

type ThreadNameObservation = {
  threadName: string;
  // Normalized, not raw: the retire check compares this against a snapshot
  // row's source, so a value no row can carry would never retire.
  titleSource: AppServerRenamedTitleSource;
};

type PrChipLocation = {
  threadIndex: number;
  prIndex: number;
};

type PrChipLocationIndex = {
  snapshot: NavigationLoadedRows;
  byPrKey: Map<string, PrChipLocation[]>;
};

function buildLaunchpadSelectionKey(directoryKey: string): string {
  return `launchpad:${directoryKey}`;
}

function buildFederatedLaunchpadSelectionKey(
  target: FederationRemoteTarget,
): string {
  return `${FEDERATED_LAUNCHPAD_SELECTION_PREFIX}${target.instanceId}`;
}

function isFederatedLaunchpadSelectionKey(selectionKey?: string): boolean {
  return selectionKey?.startsWith(FEDERATED_LAUNCHPAD_SELECTION_PREFIX) === true;
}

function getDirectoryKeyFromLaunchpadSelection(selectionKey?: string): string | undefined {
  if (!selectionKey?.startsWith("launchpad:")) {
    return undefined;
  }

  return selectionKey.slice("launchpad:".length);
}

function selectThreadWorkspace(
  thread: NavigationThreadSummary,
  mode: ThreadWorkspaceMode,
): {
  directoryKind: NavigationDirectorySummary["kind"];
  directoryLabel: string;
  directoryPath?: string;
  gitStatusSourcePath?: string;
  workMode: NavigationLaunchpadDraft["workMode"];
  branchName?: string;
} {
  const worktree = thread.linkedDirectories.find((directory) => directory.kind === "worktree");
  const local = thread.linkedDirectories.find((directory) => directory.kind === "local");
  const preferred = worktree ?? local;
  const namedBranch =
    thread.observedGitBranch && thread.observedGitBranch !== "HEAD"
      ? thread.observedGitBranch
      : thread.gitBranch && thread.gitBranch !== "HEAD"
        ? thread.gitBranch
        : undefined;

  if (mode === "new-worktree") {
    const repository =
      worktree?.worktreePath ?? worktree?.path ?? local?.path ?? thread.projectKey;
    return {
      branchName: namedBranch,
      directoryKind: repository ? "directory" : "workspace",
      directoryLabel: preferred?.label ?? thread.title,
      directoryPath: repository,
      gitStatusSourcePath: worktree?.path ?? local?.path ?? repository,
      workMode: "worktree",
    };
  }

  const sameWorkspacePath =
    mode === "same-worktree"
      ? worktree?.worktreePath ?? worktree?.path ?? local?.path ?? thread.projectKey
      : local?.path ?? thread.projectKey;
  return {
    directoryKind: sameWorkspacePath ? "directory" : "workspace",
    directoryLabel:
      mode === "local"
        ? local?.label ?? thread.title
        : preferred?.label ?? thread.title,
    directoryPath: sameWorkspacePath,
    gitStatusSourcePath:
      mode === "local"
        ? local?.path ?? sameWorkspacePath
        : worktree?.path ?? local?.path ?? sameWorkspacePath,
    workMode: "local",
    ...(mode === "same-worktree" && namedBranch ? { branchName: namedBranch } : {}),
  };
}

function compareNavigationDirectoriesByLabel(
  left: NavigationDirectorySummary,
  right: NavigationDirectorySummary
): number {
  const labelDelta = left.label.localeCompare(right.label);
  return labelDelta !== 0 ? labelDelta : left.key.localeCompare(right.key);
}

function sortNavigationDirectories(
  directories: NavigationDirectorySummary[]
): NavigationDirectorySummary[] {
  return [...directories].sort(compareNavigationDirectoriesByLabel);
}

function isInternalDirectoryLabel(value?: string): boolean {
  return Boolean(value?.startsWith("directory:") || value?.startsWith("workspace:"));
}

function displayLaunchpadDirectoryLabel(
  launchpad: NavigationLaunchpadDraft,
  existing?: NavigationDirectorySummary,
): string {
  const launchpadLabel = launchpad.directoryLabel.trim();
  if (launchpadLabel && !isInternalDirectoryLabel(launchpadLabel)) {
    return launchpadLabel;
  }

  const existingLabel = existing?.label.trim();
  if (existingLabel && !isInternalDirectoryLabel(existingLabel)) {
    return existingLabel;
  }

  if (launchpad.directoryKind === "workspace") {
    return ROOT_NEW_THREAD_WORKSPACE_LABEL;
  }

  const directoryPath =
    launchpad.directoryPath?.trim()
    ?? existing?.path?.trim()
    ?? (
      launchpad.directoryKey.startsWith("directory:")
        ? launchpad.directoryKey.slice("directory:".length).trim()
        : undefined
    );
  const normalizedPath = directoryPath?.replace(/[\\/]+$/, "");
  return (
    fileLabelFromPath(normalizedPath ?? "")
    || launchpadLabel
    || "Directory"
  );
}

function findLaunchpadSourceDirectory(
  directories: NavigationDirectorySummary[],
  launchpad: NavigationLaunchpadDraft,
  sourcePath?: string,
): NavigationDirectorySummary[][number] | undefined {
  const normalizedSourcePath = sourcePath?.trim();
  if (normalizedSourcePath) {
    const sourceDirectory = directories.find(
      (directory) =>
        directory.key !== launchpad.directoryKey &&
        directory.path?.trim() === normalizedSourcePath,
    );
    if (sourceDirectory) {
      return sourceDirectory;
    }
  }

  const launchpadPath = launchpad.directoryPath?.trim();
  if (!launchpadPath) {
    return undefined;
  }

  return directories.find(
    (directory) =>
      directory.key !== launchpad.directoryKey &&
      directory.path?.trim() === launchpadPath,
  );
}

function upsertLaunchpadDirectory(
  directories: NavigationDirectorySummary[],
  launchpad: NavigationLaunchpadDraft,
  options?: {
    gitStatus?: NavigationDirectoryGitStatus | null;
    gitStatusSourcePath?: string;
    preserveExistingDirectoryAuthority?: boolean;
  },
): NavigationDirectorySummary[] {
  let foundDirectory = false;
  const exactDirectory = directories.find(
    (directory) => directory.key === launchpad.directoryKey,
  );
  // A viewer can open a directory-less draft before its first owner snapshot
  // arrives. Once the path-backed workspace appears, the temporary
  // `workspace:new-thread` key is an alias for that row, not another project.
  const canonicalWorkspaceDirectory =
    launchpad.directoryKind === "workspace"
    && launchpad.directoryKey === ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY
      ? directories.find(
          (directory) =>
            directory.kind === "workspace"
            && directory.key !== ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY
            && Boolean(directory.path),
        )
      : undefined;
  const existingDirectory = canonicalWorkspaceDirectory ?? exactDirectory;
  const displayLabel = options?.preserveExistingDirectoryAuthority
    && existingDirectory
    ? existingDirectory.label
    : displayLaunchpadDirectoryLabel(launchpad, existingDirectory);
  const detailedGitStatus = existingDirectory?.gitStatus && "branches" in existingDirectory.gitStatus
    ? existingDirectory.gitStatus : undefined;
  const authoritativeBranchNames = new Set([
    ...(detailedGitStatus?.branches ?? []),
    ...(detailedGitStatus?.branchDetails ?? []).map(
      (branch) => branch.name,
    ),
    ...(detailedGitStatus?.baseBranches ?? []),
    ...(detailedGitStatus?.baseBranchDetails ?? []).map(
      (branch) => branch.name,
    ),
  ]);
  const branchName =
    options?.preserveExistingDirectoryAuthority
    && existingDirectory
    && authoritativeBranchNames.size > 0
    && launchpad.branchName
    && !authoritativeBranchNames.has(launchpad.branchName)
      ? existingDirectory.gitStatus?.currentBranch
      : launchpad.branchName;
  const normalizedLaunchpad = {
    ...launchpad,
    ...((options?.preserveExistingDirectoryAuthority || canonicalWorkspaceDirectory)
      && existingDirectory
      ? {
          directoryKey: existingDirectory.key,
          directoryKind: existingDirectory.kind,
          directoryLabel: existingDirectory.label,
          directoryPath: existingDirectory.path,
          branchName,
        }
      : { directoryLabel: displayLabel }),
  };
  const sourceDirectory = findLaunchpadSourceDirectory(
    directories,
    normalizedLaunchpad,
    options?.gitStatusSourcePath,
  );
  const hasGitStatusOverride =
    options && Object.prototype.hasOwnProperty.call(options, "gitStatus");
  const inheritedGitStatus = hasGitStatusOverride
    ? options.gitStatus ?? undefined
    : sourceDirectory?.gitStatus;
  const fallbackWorkspaceDirectory =
    normalizedLaunchpad.directoryKind === "workspace"
    && normalizedLaunchpad.directoryKey !== ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY
      ? directories.find(
          (directory) =>
            directory.kind === "workspace"
            && directory.key === ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY,
        )
      : undefined;
  const nextDirectories = directories.flatMap((directory) => {
    if (
      fallbackWorkspaceDirectory
      && directory.key === fallbackWorkspaceDirectory.key
    ) {
      return [];
    }

    if (directory.key !== normalizedLaunchpad.directoryKey) {
      return [directory];
    }

    foundDirectory = true;
    const next: NavigationDirectorySummary[][number] = {
      ...directory,
      kind: normalizedLaunchpad.directoryKind,
      label: displayLabel,
      path: normalizedLaunchpad.directoryPath ?? directory.path,
      launchpad: normalizedLaunchpad,
    };
    if (fallbackWorkspaceDirectory) {
      next.latestUpdatedAt = Math.max(
        directory.latestUpdatedAt ?? 0,
        fallbackWorkspaceDirectory.latestUpdatedAt ?? 0,
      ) || undefined;
    }
    if (hasGitStatusOverride) {
      if (inheritedGitStatus) {
        next.gitStatus = inheritedGitStatus;
      } else {
        delete next.gitStatus;
      }
    } else if (!directory.gitStatus && inheritedGitStatus) {
      next.gitStatus = inheritedGitStatus;
    }
    return [next];
  });

  return sortNavigationDirectories(
    foundDirectory
      ? nextDirectories
      : [
          ...nextDirectories,
          {
            ...(fallbackWorkspaceDirectory ?? {}),
            key: normalizedLaunchpad.directoryKey,
            kind: normalizedLaunchpad.directoryKind,
            label: displayLabel,
            path: normalizedLaunchpad.directoryPath,
            ...(inheritedGitStatus
              ? { gitStatus: inheritedGitStatus }
              : {}),
            launchpad: normalizedLaunchpad,
          },
        ],
  );
}

function directoryKeysForThread(thread?: NavigationThreadSummary): string[] {
  return thread?.linkedDirectories.map((directory) => classifyDirectory(directory).key) ?? [];
}

function resolveCreateThreadTargetDirectory(args: {
  directories: NavigationDirectorySummary[];
  selectedDirectory?: NavigationDirectorySummary;
  selectedThread?: NavigationThreadSummary;
  /**
   * When true, ignore the selected directory / thread context and resolve
   * straight to the directory-less workspace target. Drives the "New chat
   * without a directory" affordances (New Thread flyout + project picker).
   */
  forceWorkspace?: boolean;
}): {
  directoryKey: string;
  directoryKind: NavigationDirectorySummary["kind"];
  directoryLabel: string;
  directoryPath?: string;
  gitStatus?: NavigationDirectoryGitStatus;
} {
  const { directories, selectedDirectory, selectedThread, forceWorkspace } = args;

  if (!forceWorkspace && selectedDirectory?.kind === "directory") {
    return {
      directoryKey: selectedDirectory.key,
      directoryKind: selectedDirectory.kind,
      directoryLabel: selectedDirectory.label,
      directoryPath: selectedDirectory.path,
      gitStatus: selectedDirectory.gitStatus,
    };
  }

  if (!forceWorkspace && selectedThread) {
    const threadDirectories = directories.filter(
      (directory) =>
        directory.kind === "directory" && directoryKeysForThread(selectedThread).includes(directory.key)
    );
    if (threadDirectories.length === 1) {
      const [threadDirectory] = threadDirectories;
      if (threadDirectory) {
        return {
          directoryKey: threadDirectory.key,
          directoryKind: threadDirectory.kind,
          directoryLabel: threadDirectory.label,
          directoryPath: threadDirectory.path,
          gitStatus: threadDirectory.gitStatus,
        };
      }
    }
  }

  const workspaceDirectory = directories.find((directory) => directory.kind === "workspace");
  return {
    directoryKey: workspaceDirectory?.key ?? ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY,
    directoryKind: "workspace",
    directoryLabel: workspaceDirectory?.label ?? ROOT_NEW_THREAD_WORKSPACE_LABEL,
    directoryPath: workspaceDirectory?.path,
    gitStatus: workspaceDirectory?.gitStatus,
  };
}

function formatArchiveCleanupNotice(
  cleanup: ArchiveThreadCleanupResult[]
): ArchiveThreadNotice | undefined {
  const failures = cleanup.filter(
    (item) => !item.removedWorktree || item.error || item.skippedReason
  );
  const firstFailure = failures[0];
  if (!firstFailure) {
    return undefined;
  }

  const reason = firstFailure.error ?? firstFailure.skippedReason ?? "cleanup was skipped";
  const sharedWorktree = reason.startsWith("Worktree is still used by");
  const title = sharedWorktree ? "Worktree kept" : "Worktree cleanup skipped";
  const message = sharedWorktree
    ? "Thread archived. The worktree was kept because another active thread is still using it."
    : "Thread archived. The worktree cleanup did not complete.";
  const detail = firstFailure.worktreePath
    ? `${firstFailure.worktreePath}: ${reason}`
    : reason;

  return {
    id: [firstFailure.worktreePath ?? "no-worktree", reason, Date.now().toString()].join("\n"),
    title,
    message,
    detail,
  };
}

function linkedDirectoriesEqual(
  left: NavigationThreadSummary["linkedDirectories"],
  right: NavigationThreadSummary["linkedDirectories"]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((directory, index) => {
    const candidate = right[index];
    return (
      directory?.id === candidate?.id &&
      directory?.label === candidate?.label &&
      directory?.path === candidate?.path &&
      directory?.worktreePath === candidate?.worktreePath &&
      directory?.kind === candidate?.kind
    );
  });
}

function worktreeSnapshotsEqual(
  left: NavigationThreadSummary["worktreeSnapshots"],
  right: NavigationThreadSummary["worktreeSnapshots"]
): boolean {
  const leftSnapshots = left ?? [];
  const rightSnapshots = right ?? [];
  if (leftSnapshots.length !== rightSnapshots.length) {
    return false;
  }

  return leftSnapshots.every((snapshot, index) => {
    const candidate = rightSnapshots[index];
    if (!candidate) {
      return false;
    }

    return (
      snapshot.id === candidate.id &&
      snapshot.worktreePath === candidate.worktreePath &&
      snapshot.repositoryPath === candidate.repositoryPath &&
      snapshot.snapshotRef === candidate.snapshotRef &&
      snapshot.snapshotCommit === candidate.snapshotCommit &&
      snapshot.state === candidate.state &&
      snapshot.archivedAt === candidate.archivedAt &&
      snapshot.restoredAt === candidate.restoredAt
    );
  });
}

function threadInboxEqual(
  left: NavigationThreadSummary["inbox"],
  right: NavigationThreadSummary["inbox"]
): boolean {
  return (
    left.inInbox === right.inInbox &&
    left.reason === right.reason &&
    left.lastSeenAt === right.lastSeenAt &&
    left.lastSeenUpdatedAt === right.lastSeenUpdatedAt
  );
}

function retainedBranchDriftPairsEqual(
  left: NavigationThreadSummary["retainedBranchDriftPairs"],
  right: NavigationThreadSummary["retainedBranchDriftPairs"]
): boolean {
  const leftPairs = left ?? [];
  const rightPairs = right ?? [];
  if (leftPairs.length !== rightPairs.length) {
    return false;
  }

  return leftPairs.every((pair, index) => {
    const candidate = rightPairs[index];
    return (
      candidate?.expectedBranch === pair.expectedBranch &&
      candidate.observedBranch === pair.observedBranch &&
      candidate.retainedAt === pair.retainedAt
    );
  });
}

function messagingBindingsEqual(
  left: NavigationThreadSummary["messagingBindings"],
  right: NavigationThreadSummary["messagingBindings"]
): boolean {
  const leftBindings = left ?? [];
  const rightBindings = right ?? [];
  if (leftBindings.length !== rightBindings.length) {
    return false;
  }

  return leftBindings.every((binding, index) => {
    const candidate = rightBindings[index];
    return (
      candidate?.bindingId === binding.bindingId &&
      candidate.platform === binding.platform &&
      candidate.conversationKind === binding.conversationKind &&
      candidate.conversationTitle === binding.conversationTitle &&
      candidate.parentTitle === binding.parentTitle &&
      candidate.ancestorTitle === binding.ancestorTitle &&
      candidate.activeAt === binding.activeAt
    );
  });
}

function automationSummariesEqual(
  left: NavigationThreadSummary["automationSummary"],
  right: NavigationThreadSummary["automationSummary"]
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function threadAgentsEqual(
  left: NavigationThreadSummary["agent"],
  right: NavigationThreadSummary["agent"],
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.name === right.name &&
    left.instructions === right.instructions &&
    left.instructionLineCount === right.instructionLineCount &&
    left.instructionsTooLong === right.instructionsTooLong &&
    left.updatedAt === right.updatedAt
  );
}

function prSummariesEqual(
  left: NavigationThreadSummary["prs"],
  right: NavigationThreadSummary["prs"]
): boolean {
  const leftPrs = left ?? [];
  const rightPrs = right ?? [];
  if (leftPrs.length !== rightPrs.length) {
    return false;
  }

  return leftPrs.every((pr, index) => {
    const candidate = rightPrs[index];
    return (
      candidate?.number === pr.number &&
      candidate.provider === pr.provider &&
      candidate.org === pr.org &&
      candidate.repo === pr.repo &&
      candidate.title === pr.title &&
      candidate.state === pr.state &&
      candidate.checkState === pr.checkState &&
      candidate.checksStillRunning === pr.checksStillRunning &&
      candidate.lifecycleState === pr.lifecycleState &&
      candidate.reviewState === pr.reviewState &&
      candidate.mergeState === pr.mergeState &&
      JSON.stringify(candidate.commitShas ?? []) === JSON.stringify(pr.commitShas ?? []) &&
      candidate.url === pr.url
    );
  });
}

function reactionsEqual(
  left: NavigationThreadSummary["reactions"],
  right: NavigationThreadSummary["reactions"]
): boolean {
  const leftReactions = left ?? [];
  const rightReactions = right ?? [];
  if (leftReactions.length !== rightReactions.length) {
    return false;
  }

  return leftReactions.every(
    (reaction, index) => rightReactions[index] === reaction
  );
}

function subAgentsEqual(
  left: NavigationThreadSummary["subAgents"],
  right: NavigationThreadSummary["subAgents"]
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function permissionTransitionLogsEqual(
  left: NavigationThreadSummary["permissionTransitionLog"],
  right: NavigationThreadSummary["permissionTransitionLog"]
): boolean {
  const leftLog = left ?? [];
  const rightLog = right ?? [];
  if (leftLog.length !== rightLog.length) {
    return false;
  }

  return leftLog.every((entry, index) => {
    const candidate = rightLog[index];
    return (
      candidate?.id === entry.id &&
      candidate.fromExecutionMode === entry.fromExecutionMode &&
      candidate.toExecutionMode === entry.toExecutionMode &&
      candidate.fromLabel === entry.fromLabel &&
      candidate.toLabel === entry.toLabel &&
      candidate.status === entry.status &&
      candidate.occurredAt === entry.occurredAt &&
      candidate.queueId === entry.queueId &&
      candidate.note === entry.note
    );
  });
}

function messagingBindingTransitionLogsEqual(
  left: NavigationThreadSummary["messagingBindingTransitionLog"],
  right: NavigationThreadSummary["messagingBindingTransitionLog"]
): boolean {
  const leftLog = left ?? [];
  const rightLog = right ?? [];
  if (leftLog.length !== rightLog.length) {
    return false;
  }

  return leftLog.every((entry, index) => {
    const candidate = rightLog[index];
    return (
      candidate?.id === entry.id &&
      candidate.action === entry.action &&
      candidate.bindingId === entry.bindingId &&
      candidate.platform === entry.platform &&
      candidate.conversationKind === entry.conversationKind &&
      candidate.conversationTitle === entry.conversationTitle &&
      candidate.parentTitle === entry.parentTitle &&
      candidate.ancestorTitle === entry.ancestorTitle &&
      candidate.occurredAt === entry.occurredAt
    );
  });
}

function questionnaireActivityLogsEqual(
  left: NavigationThreadSummary["questionnaireActivityLog"],
  right: NavigationThreadSummary["questionnaireActivityLog"]
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function threadSummariesEqual(
  left: NavigationPresentedThread,
  right: NavigationPresentedThread
): boolean {
  return (
    left.rowRevision === right.rowRevision &&
    left.ordinaryChildCount === right.ordinaryChildCount &&
    left.nativeSubAgentGroupPresent === right.nativeSubAgentGroupPresent &&
    left.nativeSubAgentCount === right.nativeSubAgentCount &&
    left.id === right.id &&
    left.source === right.source &&
    left.title === right.title &&
    left.titleSource === right.titleSource &&
    left.summary === right.summary &&
    left.projectKey === right.projectKey &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.threadStatus === right.threadStatus &&
    left.gitBranch === right.gitBranch &&
    left.observedGitBranch === right.observedGitBranch &&
    left.primaryGitRepository === right.primaryGitRepository &&
    // Federation reachability changes independently of owner thread data.
    // Include the whole stamp so a successful reconnect cannot reuse the
    // previous disconnected row and leave it dimmed indefinitely.
    JSON.stringify(left.federation ?? null) ===
      JSON.stringify(right.federation ?? null) &&
    // Working state is probed on its own cadence (background refresh +
    // post-turn invalidation), independent of `updatedAt` — like PRs and
    // messaging bindings below. Without this check the reconciler would
    // reuse the previous thread reference and the dirty/unpushed chips
    // would stay stale until some other field changed.
    JSON.stringify(left.gitWorkingState ?? null) ===
      JSON.stringify(right.gitWorkingState ?? null) &&
    left.executionMode === right.executionMode &&
    left.queuedExecutionMode === right.queuedExecutionMode &&
    left.queuedExecutionModeAt === right.queuedExecutionModeAt &&
    JSON.stringify(left.queuedTurns ?? []) ===
      JSON.stringify(right.queuedTurns ?? []) &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier &&
    left.fastMode === right.fastMode &&
    left.tokenMiserEnabled === right.tokenMiserEnabled &&
    left.prAutoDispatchEnabled === right.prAutoDispatchEnabled &&
    JSON.stringify(left.prAutoDispatchPending ?? null) ===
      JSON.stringify(right.prAutoDispatchPending ?? null) &&
    JSON.stringify(left.acpRuntime ?? {}) === JSON.stringify(right.acpRuntime ?? {}) &&
    JSON.stringify(left.workspaceHandoff ?? {}) ===
      JSON.stringify(right.workspaceHandoff ?? {}) &&
    left.pinnedRank === right.pinnedRank &&
    left.parentThreadId === right.parentThreadId &&
    left.parentThreadBackend === right.parentThreadBackend &&
    left.parentThreadInstanceId === right.parentThreadInstanceId &&
    JSON.stringify(left.subthreadOrder ?? []) ===
      JSON.stringify(right.subthreadOrder ?? []) &&
    left.subthreadsCollapsed === right.subthreadsCollapsed &&
    retainedBranchDriftPairsEqual(
      left.retainedBranchDriftPairs,
      right.retainedBranchDriftPairs
    ) &&
    linkedDirectoriesEqual(left.linkedDirectories, right.linkedDirectories) &&
    worktreeSnapshotsEqual(left.worktreeSnapshots, right.worktreeSnapshots) &&
    threadInboxEqual(left.inbox, right.inbox) &&
    // Bindings and PRs mutate independently of `updatedAt`: the messaging
    // store revokes a binding row without touching the thread row, and
    // GitHub PR detection runs on its own cadence. Reactions can also be
    // changed by another app instance while the backend thread record is
    // otherwise unchanged. Without these checks the reconciler reuses the
    // previous thread reference whenever nothing else changed and chips on
    // the row stay stale until something else triggers a re-render.
    messagingBindingsEqual(left.messagingBindings, right.messagingBindings) &&
    automationSummariesEqual(left.automationSummary, right.automationSummary) &&
    threadAgentsEqual(left.agent, right.agent) &&
    prSummariesEqual(left.prs, right.prs) &&
    reactionsEqual(left.reactions, right.reactions) &&
    subAgentsEqual(left.subAgents, right.subAgents) &&
    permissionTransitionLogsEqual(
      left.permissionTransitionLog,
      right.permissionTransitionLog
    ) &&
    messagingBindingTransitionLogsEqual(
      left.messagingBindingTransitionLog,
      right.messagingBindingTransitionLog
    ) &&
    questionnaireActivityLogsEqual(
      left.questionnaireActivityLog,
      right.questionnaireActivityLog
    )
  );
}

function hasPlaceholderThreadTitle(thread: NavigationThreadSummary): boolean {
  return (
    thread.titleSource === "fallback" &&
    (thread.title === thread.id || thread.title === "Untitled thread")
  );
}

function reconcileLoadedNavigationRows(
  previous: NavigationLoadedRows | undefined,
  next: NavigationLoadedRows
): NavigationLoadedRows {
  if (!previous) {
    return next;
  }

  const previousByThreadKey = new Map(
    loadedThreadRows(previous).map((thread) => [
      threadSummaryIdentityKey(thread),
      thread,
    ])
  );
  const previousByDirectoryKey = new Map(
    loadedDirectoryRows(previous).map((directory) => [directory.key, directory])
  );
  const reconciledDirectories = loadedDirectoryRows(next).map((directory) => {
    const previousDirectory = previousByDirectoryKey.get(directory.key);
    return {
      ...directory,
      ...(previousDirectory?.gitStatus &&
      !Object.prototype.hasOwnProperty.call(directory, "gitStatus")
        ? { gitStatus: previousDirectory.gitStatus }
        : {}),
    };
  });

  return {
    ...next,
    directoryRows: indexLoadedDirectoryRows(sortNavigationDirectories(reconciledDirectories)),
    threadRows: indexLoadedThreadRows(loadedThreadRows(next).map((thread) => {
      const previousThread = previousByThreadKey.get(
        threadSummaryIdentityKey(thread)
      );
      return previousThread && threadSummariesEqual(previousThread, thread)
        ? previousThread
        : thread;
    })),
  };
}

function applyFederationPeerStatusUpdate(
  snapshot: NavigationLoadedRows | undefined,
  instanceId: string,
  status: FederationPeerSummary["status"],
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }
  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (
      !thread.federation
      || !isRemoteFederationTarget(thread.federation.ref.target)
      || thread.federation.ref.target.instanceId !== instanceId
      || thread.federation.peerStatus === status
    ) {
      return thread;
    }
    changed = true;
    return {
      ...thread,
      federation: {
        ...thread.federation,
        peerStatus: status,
      },
    };
  });
  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function applyDirectoryGitStatusUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: NavigationDirectoryGitStatusUpdatedNotification["params"],
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const directories = loadedDirectoryRows(snapshot).map((directory) => {
    if (directory.key !== params.directoryKey) {
      return directory;
    }
    if (JSON.stringify(directory.gitStatus ?? null) === JSON.stringify(params.gitStatus)) {
      return directory;
    }

    changed = true;
    const next = { ...directory };
    if (params.gitStatus) {
      next.gitStatus = params.gitStatus;
    } else {
      delete next.gitStatus;
    }
    return next;
  });

  return changed ? { ...snapshot, directoryRows: indexLoadedDirectoryRows(directories) } : snapshot;
}

function applyThreadGitWorkingStateUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: NavigationThreadGitWorkingStateUpdatedNotification["params"],
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (resolveThreadWorkingStatePath(thread) !== params.worktreePath) {
      return thread;
    }
    if (
      thread.gitWorkingStateFetchedAt === params.fetchedAt
      && JSON.stringify(thread.gitWorkingState ?? null) ===
        JSON.stringify(params.gitWorkingState)
    ) {
      return thread;
    }

    changed = true;
    if (params.gitWorkingState) {
      return {
        ...thread,
        gitWorkingState: params.gitWorkingState,
        gitWorkingStateFetchedAt: params.fetchedAt,
      };
    }
    const { gitWorkingState: _removed, ...rest } = thread;
    return { ...rest, gitWorkingStateFetchedAt: params.fetchedAt };
  });

  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function updateThreadReactionsInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    reactions: string[];
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (buildThreadIdentityKey(thread.source, thread.id) !== threadKey) {
      return thread;
    }
    if (
      !federationTargetsEqual(
        thread.federation?.ref.target,
        params.federationTarget,
      )
    ) {
      return thread;
    }
    const current = thread.reactions ?? [];
    if (
      current.length === params.reactions.length &&
      current.every((emoji, index) => emoji === params.reactions[index])
    ) {
      return thread;
    }
    changed = true;
    return { ...thread, reactions: params.reactions };
  });

  if (!changed) {
    return snapshot;
  }

  return { ...snapshot, threadRows: indexLoadedThreadRows(threads) };
}

function updateThreadSubAgentsInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    subAgents: ThreadSubAgentSummary[];
    threadId: string;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }
  const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (
      buildThreadIdentityKey(thread.source, thread.id) !== threadKey
      || !federationTargetsEqual(
        thread.federation?.ref.target,
        params.federationTarget,
      )
    ) {
      return thread;
    }
    changed = true;
    return { ...thread, subAgents: params.subAgents };
  });
  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function updateThreadPinInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    pinnedRank?: string;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  const threadKey = params.federationTarget
    && isRemoteFederationTarget(params.federationTarget)
    ? federatedThreadIdentityKey({
        backend: params.backend,
        target: params.federationTarget,
        threadId: params.threadId,
      })
    : buildThreadIdentityKey(params.backend, params.threadId);
  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (threadSummaryIdentityKey(thread) !== threadKey) {
      return thread;
    }
    if (thread.pinnedRank === params.pinnedRank) {
      return thread;
    }
    changed = true;
    return { ...thread, pinnedRank: params.pinnedRank };
  });

  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function updateThreadAgentInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    agent?: ThreadAgentMetadata;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }
    if (threadAgentsEqual(thread.agent, params.agent)) {
      return thread;
    }
    changed = true;
    return { ...thread, agent: params.agent };
  });

  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function updateThreadPinsInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    /** Thread identity key -> pin rank. Pin order is global across backends. */
    pinnedRanksByThreadKey: Record<string, string>;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    const pinnedRank =
      params.pinnedRanksByThreadKey[
        threadSummaryIdentityKey(thread)
      ];
    if (!pinnedRank || thread.pinnedRank === pinnedRank) {
      return thread;
    }
    changed = true;
    return { ...thread, pinnedRank };
  });

  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function updateThreadParentInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    parentThreadId?: string;
    parentThreadBackend?: AppServerBackendKind;
    parentThreadInstanceId?: string;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }
    if (
      !federationTargetsEqual(
        thread.federation?.ref.target,
        params.federationTarget,
      )
    ) {
      return thread;
    }
    if (
      thread.parentThreadId === params.parentThreadId
      && thread.parentThreadBackend === params.parentThreadBackend
      && thread.parentThreadInstanceId === params.parentThreadInstanceId
    ) {
      return thread;
    }
    changed = true;
    return {
      ...thread,
      parentThreadId: params.parentThreadId,
      parentThreadBackend: params.parentThreadId
        ? params.parentThreadBackend ?? params.backend
        : undefined,
      parentThreadInstanceId: params.parentThreadId
        ? params.parentThreadInstanceId
        : undefined,
      pinnedRank: params.parentThreadId ? undefined : thread.pinnedRank,
    };
  });

  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function ungroupChildThreadsInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    parent: NavigationThreadSummary;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threadByKey = new Map(
    loadedThreadRows(snapshot).map((thread) => [
      threadSummaryIdentityKey(thread),
      thread,
    ]),
  );
  const parentKey = threadSummaryIdentityKey(params.parent);
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (resolveThreadParentKey(thread, threadByKey) !== parentKey) {
      return thread;
    }
    changed = true;
    return {
      ...thread,
      parentThreadId: undefined,
      parentThreadBackend: undefined,
      parentThreadInstanceId: undefined,
    };
  });

  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}


function updateSubthreadOrderInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    parentThreadId: string;
    threadIds: string[];
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.parentThreadId) {
      return thread;
    }
    if (
      !federationTargetsEqual(
        thread.federation?.ref.target,
        params.federationTarget,
      )
    ) {
      return thread;
    }
    if (JSON.stringify(thread.subthreadOrder ?? []) === JSON.stringify(params.threadIds)) {
      return thread;
    }
    changed = true;
    return { ...thread, subthreadOrder: params.threadIds };
  });

  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function updateSubthreadsCollapsedInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    parentThreadId: string;
    collapsed: boolean;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.parentThreadId) {
      return thread;
    }
    if (
      !federationTargetsEqual(
        thread.federation?.ref.target,
        params.federationTarget,
      )
    ) {
      return thread;
    }
    if (thread.subthreadsCollapsed === params.collapsed) {
      return thread;
    }
    changed = true;
    return { ...thread, subthreadsCollapsed: params.collapsed };
  });

  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

/**
 * Directory pin patchers — mirror of `updateThreadPin{,s}InSnapshot`
 * minus the per-backend dimension (plan 2026-05-09-002 Units I + J).
 * Both return the same snapshot reference when nothing changes so
 * React skips the re-render. The IPC + bus paths converge on the
 * same patcher so the optimistic update and the authoritative
 * response collapse into a no-op when they agree.
 */
function updateDirectoryPinInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    directoryKey: string;
    pinnedRank?: string;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const directories = loadedDirectoryRows(snapshot).map((directory) => {
    if (directory.key !== params.directoryKey) {
      return directory;
    }
    if (directory.pinnedRank === params.pinnedRank) {
      return directory;
    }
    changed = true;
    return { ...directory, pinnedRank: params.pinnedRank };
  });

  return changed ? { ...snapshot, directoryRows: indexLoadedDirectoryRows(directories) } : snapshot;
}

function updateDirectoryPinsInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    pinnedRanks: Record<string, string>;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const directories = loadedDirectoryRows(snapshot).map((directory) => {
    const pinnedRank = params.pinnedRanks[directory.key];
    if (!pinnedRank || directory.pinnedRank === pinnedRank) {
      return directory;
    }
    changed = true;
    return { ...directory, pinnedRank };
  });

  return changed ? { ...snapshot, directoryRows: indexLoadedDirectoryRows(directories) } : snapshot;
}

function updateDirectoryThreadsCollapsedInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    directoryKey: string;
    collapsed: boolean;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const directories = loadedDirectoryRows(snapshot).map((directory) => {
    if (directory.key !== params.directoryKey) {
      return directory;
    }
    if (directory.directoryThreadsCollapsed === params.collapsed) {
      return directory;
    }
    changed = true;
    return {
      ...directory,
      directoryThreadsCollapsed: params.collapsed,
    };
  });

  return changed ? { ...snapshot, directoryRows: indexLoadedDirectoryRows(directories) } : snapshot;
}

function markThreadsSeenInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: Array<{
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    seenUpdatedAt?: number;
  }>,
): NavigationLoadedRows | undefined {
  if (!snapshot || params.length === 0) {
    return snapshot;
  }

  const seenUpdatedAtByThreadKey = new Map(
    params.map((entry) => [
      entry.federationTarget && isRemoteFederationTarget(entry.federationTarget)
        ? federatedThreadIdentityKey({
            backend: entry.backend,
            target: entry.federationTarget,
            threadId: entry.threadId,
          })
        : buildThreadIdentityKey(entry.backend, entry.threadId),
      entry.seenUpdatedAt,
    ]),
  );
  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    const threadKey = threadSummaryIdentityKey(thread);
    if (!seenUpdatedAtByThreadKey.has(threadKey)) {
      return thread;
    }
    const seenUpdatedAt = seenUpdatedAtByThreadKey.get(threadKey);

    if (
      seenUpdatedAt !== undefined &&
      thread.updatedAt !== undefined &&
      thread.updatedAt > seenUpdatedAt
    ) {
      return thread;
    }

    if (!thread.inbox.inInbox && thread.inbox.lastSeenUpdatedAt === seenUpdatedAt) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      inbox: {
        ...thread.inbox,
        inInbox: false,
        reason: undefined,
        lastSeenAt: Date.now(),
        lastSeenUpdatedAt: seenUpdatedAt,
      },
    };
  });

  if (!changed) {
    return snapshot;
  }


  return {
    ...snapshot,
    threadRows: indexLoadedThreadRows(threads),
  };
}

function markThreadSeenInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    seenUpdatedAt?: number;
  },
): NavigationLoadedRows | undefined {
  return markThreadsSeenInLoadedRows(snapshot, [params]);
}

function markThreadUnreadInLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    seenUpdatedAt: number;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  const threadKey = params.federationTarget
    && isRemoteFederationTarget(params.federationTarget)
    ? federatedThreadIdentityKey({
        backend: params.backend,
        target: params.federationTarget,
        threadId: params.threadId,
      })
    : buildThreadIdentityKey(params.backend, params.threadId);
  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (threadSummaryIdentityKey(thread) !== threadKey) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      inbox: {
        ...thread.inbox,
        inInbox: true,
        reason: "updated-since-seen" as const,
        lastSeenUpdatedAt: params.seenUpdatedAt,
      },
    };
  });

  if (!changed) {
    return snapshot;
  }


  return {
    ...snapshot,
    threadRows: indexLoadedThreadRows(threads),
  };
}

function removeThreadFromLoadedRows(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  const threadKey = params.federationTarget
    && isRemoteFederationTarget(params.federationTarget)
    ? federatedThreadIdentityKey({
        backend: params.backend,
        target: params.federationTarget,
        threadId: params.threadId,
      })
    : buildThreadIdentityKey(params.backend, params.threadId);
  const threads = loadedThreadRows(snapshot).filter(
    (thread) => threadSummaryIdentityKey(thread) !== threadKey
  );
  if (threads.length === loadedThreadRows(snapshot).length) {
    return snapshot;
  }


  return {
    ...snapshot,
    threadRows: indexLoadedThreadRows(threads),
  };
}

function getFallbackSelectionAfterRemoval(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    optimisticThreadKey?: string;
  }
): string | undefined {
  const nextSnapshot = removeThreadFromLoadedRows(snapshot, params);
  return nextSnapshot
    ? getFallbackSelectionKey(nextSnapshot, params.optimisticThreadKey)
    : undefined;
}

function applyThreadNameUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    threadName?: string;
    titleSource: AppServerRenamedTitleSource;
  }
): NavigationLoadedRows | undefined {
  const threadName = params.threadName?.trim();
  if (!snapshot || !threadName) {
    return snapshot;
  }
  const titleSource = params.titleSource;
  const threadKey = params.federationTarget
    ? federatedThreadIdentityKey({
        backend: params.backend,
        target: params.federationTarget,
        threadId: params.threadId,
      })
    : buildThreadIdentityKey(params.backend, params.threadId);
  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (threadSummaryIdentityKey(thread) !== threadKey) {
      return thread;
    }

    if (thread.title === threadName && thread.titleSource === titleSource) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      title: threadName,
      titleSource,
    };
  });

  return changed
    ? {
        ...snapshot,
        threadRows: indexLoadedThreadRows(threads),
      }
    : snapshot;
}

function applyThreadRewindUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    updatedAt: number;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (
      thread.source !== params.backend
      || thread.id !== params.threadId
      || !federationTargetsEqual(
        thread.federation?.ref.target,
        params.federationTarget,
      )
    ) {
      return thread;
    }
    const updatedAt = Math.max(thread.updatedAt ?? 0, params.updatedAt);
    if (thread.updatedAt === updatedAt && thread.threadStatus === "idle") {
      return thread;
    }
    changed = true;
    return {
      ...thread,
      threadStatus: "idle" as const,
      updatedAt,
    };
  });

  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function applyThreadStatusUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    threadStatus: AppServerThreadStatus;
  }
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }
    if (
      !federationTargetsEqual(
        thread.federation?.ref.target,
        params.federationTarget,
      )
    ) {
      return thread;
    }
    if (thread.threadStatus === params.threadStatus) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      threadStatus: params.threadStatus,
    };
  });

  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function applyThreadPullRequestsUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    prs: PrSummary[];
    federationTarget?: FederationTarget;
  }
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }

    // A thread's attachment list is owned by the instance the thread
    // lives on, so match the origin too: in a window that shows local
    // threads alongside pinned remote ones, a peer's event must not
    // rewrite a local thread that happens to share the id, and vice
    // versa.
    if (
      !federationTargetsEqual(
        thread.federation?.ref.target,
        params.federationTarget,
      )
    ) {
      return thread;
    }

    if (prSummariesEqual(thread.prs, params.prs)) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      prs: params.prs,
    };
  });

  return changed
    ? {
        ...snapshot,
        threadRows: indexLoadedThreadRows(threads),
      }
    : snapshot;
}

function applyPullRequestStatusUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: { prKey: string; pr: PrSummary; index?: PrChipLocationIndex }
): { snapshot: NavigationLoadedRows | undefined; index: PrChipLocationIndex | undefined } {
  if (!snapshot) {
    return { snapshot, index: undefined };
  }

  const index =
    params.index && (params.index.snapshot === snapshot || samePrChipMembership(params.index.snapshot, snapshot))
      ? params.index
      : buildPrChipLocationIndex(snapshot);
  const locations = index.byPrKey.get(params.prKey);
  if (!locations?.length) {
    return { snapshot, index };
  }

  let threads: NavigationThreadSummary[] | undefined;
  const updatedThreadIndexes = new Set<number>();
  for (const location of locations) {
    const sourceThreads = threads ?? loadedThreadRows(snapshot);
    const thread = sourceThreads[location.threadIndex];
    const currentPr = thread?.prs?.[location.prIndex];
    if (!thread || !currentPr) {
      continue;
    }
    if (buildPullRequestStatusKey(currentPr) !== params.prKey) {
      continue;
    }
    if (prSummariesEqual([currentPr], [params.pr])) {
      continue;
    }

    if (!threads) {
      threads = [...loadedThreadRows(snapshot)];
    }
    if (!updatedThreadIndexes.has(location.threadIndex)) {
      threads[location.threadIndex] = {
        ...thread,
        prs: [...(thread.prs ?? [])],
      };
      updatedThreadIndexes.add(location.threadIndex);
    }
    threads[location.threadIndex]!.prs![location.prIndex] = params.pr;
  }

  if (!threads) {
    return { snapshot, index };
  }

  const nextSnapshot = {
    ...snapshot,
    threadRows: indexLoadedThreadRows(threads),
  };
  return {
    snapshot: nextSnapshot,
    index: {
      snapshot: nextSnapshot,
      byPrKey: index.byPrKey,
    },
  };
}

function samePrChipMembership(left: NavigationLoadedRows, right: NavigationLoadedRows): boolean {
  const previous = loadedThreadRows(left);
  const current = loadedThreadRows(right);
  return previous.length === current.length && previous.every((thread, index) =>
    threadSummaryIdentityKey(thread) === threadSummaryIdentityKey(current[index]!) && thread.prs === current[index]!.prs);
}

function buildPrChipLocationIndex(
  snapshot: NavigationLoadedRows,
): PrChipLocationIndex {
  const byPrKey = new Map<string, PrChipLocation[]>();
  loadedThreadRows(snapshot).forEach((thread, threadIndex) => {
    thread.prs?.forEach((pr, prIndex) => {
      const prKey = buildPullRequestStatusKey(pr);
      const locations = byPrKey.get(prKey) ?? [];
      locations.push({ threadIndex, prIndex });
      byPrKey.set(prKey, locations);
    });
  });

  return {
    snapshot,
    byPrKey,
  };
}

function applyThreadModelSettingsUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    fastMode?: boolean;
  }
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      ...("model" in params ? { model: params.model } : {}),
      ...("reasoningEffort" in params
        ? { reasoningEffort: params.reasoningEffort }
        : {}),
      ...("serviceTier" in params ? { serviceTier: params.serviceTier } : {}),
      ...("fastMode" in params ? { fastMode: params.fastMode } : {}),
    };
  });

  return changed
    ? {
        ...snapshot,
        threadRows: indexLoadedThreadRows(threads),
      }
    : snapshot;
}

function applyThreadPrAutoDispatchUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    enabled: boolean;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }
  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (
      thread.source !== params.backend
      || thread.id !== params.threadId
      || !federationTargetsEqual(
        thread.federation?.ref.target,
        params.federationTarget,
      )
    ) {
      return thread;
    }
    changed = true;
    return { ...thread, prAutoDispatchEnabled: params.enabled };
  });
  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function applyThreadPrAutoDispatchPendingUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
    pending: NavigationThreadSummary["prAutoDispatchPending"];
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) return snapshot;
  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (
      thread.source !== params.backend
      || thread.id !== params.threadId
      || !federationTargetsEqual(
        thread.federation?.ref.target,
        params.federationTarget,
      )
    ) {
      return thread;
    }
    changed = true;
    return { ...thread, prAutoDispatchPending: params.pending };
  });
  return changed ? { ...snapshot, threadRows: indexLoadedThreadRows(threads) } : snapshot;
}

function applyThreadAcpRuntimeUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    acpRuntime?: NavigationThreadSummary["acpRuntime"];
  }
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      acpRuntime: {
        ...thread.acpRuntime,
        ...params.acpRuntime,
        configValues: {
          ...(thread.acpRuntime?.configValues ?? {}),
          ...(params.acpRuntime?.configValues ?? {}),
        },
      },
    };
  });

  return changed
    ? {
        ...snapshot,
        threadRows: indexLoadedThreadRows(threads),
      }
    : snapshot;
}

function applyThreadCodexEnvironmentUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    codexEnvironmentRuntime?: NavigationThreadSummary["codexEnvironmentRuntime"];
  }
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      codexEnvironmentRuntime: params.codexEnvironmentRuntime,
    };
  });

  return changed
    ? {
        ...snapshot,
        threadRows: indexLoadedThreadRows(threads),
      }
    : snapshot;
}

function applyThreadExecutionModeUpdate(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    executionMode: "default" | "full-access";
  }
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }

    if (thread.executionMode === params.executionMode) {
      return thread;
    }

    changed = true;
    return {
      ...thread,
      executionMode: params.executionMode,
    };
  });

  return changed
    ? {
        ...snapshot,
        threadRows: indexLoadedThreadRows(threads),
      }
    : snapshot;
}

function applyThreadExecutionModeQueued(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
    queuedExecutionMode: "default" | "full-access";
    queuedAt: number;
  }
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }
    if (
      thread.queuedExecutionMode === params.queuedExecutionMode &&
      thread.queuedExecutionModeAt === params.queuedAt
    ) {
      return thread;
    }
    changed = true;
    return {
      ...thread,
      queuedExecutionMode: params.queuedExecutionMode,
      queuedExecutionModeAt: params.queuedAt,
    };
  });

  return changed
    ? {
        ...snapshot,
        threadRows: indexLoadedThreadRows(threads),
      }
    : snapshot;
}

function applyThreadExecutionModeQueueCleared(
  snapshot: NavigationLoadedRows | undefined,
  params: {
    backend: AppServerBackendKind;
    threadId: string;
  }
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  let changed = false;
  const threads = loadedThreadRows(snapshot).map((thread) => {
    if (thread.source !== params.backend || thread.id !== params.threadId) {
      return thread;
    }
    if (
      thread.queuedExecutionMode === undefined &&
      thread.queuedExecutionModeAt === undefined
    ) {
      return thread;
    }
    changed = true;
    return {
      ...thread,
      queuedExecutionMode: undefined,
      queuedExecutionModeAt: undefined,
    };
  });

  return changed
    ? {
        ...snapshot,
        threadRows: indexLoadedThreadRows(threads),
      }
    : snapshot;
}

function applyLaunchpadUpdate(
  snapshot: NavigationLoadedRows | undefined,
  launchpad: NavigationLaunchpadDraft,
  defaults: NavigationLaunchpadDefaults | undefined,
  options?: {
    gitStatus?: NavigationDirectoryGitStatus | null;
    gitStatusSourcePath?: string;
    preserveExistingDirectoryAuthority?: boolean;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return {
      threadRows: indexLoadedThreadRows([]),
      
      directoryRows: indexLoadedDirectoryRows(upsertLaunchpadDirectory([], launchpad, options)),
      launchpadDefaults: defaults,
    };
  }

  return {
    ...snapshot,
    directoryRows: indexLoadedDirectoryRows(upsertLaunchpadDirectory(loadedDirectoryRows(snapshot), launchpad, options)),
    launchpadDefaults: defaults,
  };
}

function applyLaunchpadUpdateIfMissing(
  snapshot: NavigationLoadedRows | undefined,
  launchpad: NavigationLaunchpadDraft,
  defaults: NavigationLaunchpadDefaults,
  options?: {
    preserveExistingDirectoryAuthority?: boolean;
  },
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return applyLaunchpadUpdate(snapshot, launchpad, defaults, options);
  }

  if (loadedDirectoryRows(snapshot).some(
    (directory) =>
      directory.key === launchpad.directoryKey && Boolean(directory.launchpad)
  )) {
    return snapshot;
  }

  return applyLaunchpadUpdate(snapshot, launchpad, defaults, options);
}

function mergeLaunchpadUpdateResponse(
  current: NavigationLaunchpadDraft | undefined,
  next: NavigationLaunchpadDraft,
  patch: Parameters<NonNullable<DesktopApi["updateDirectoryLaunchpad"]>>[0]["patch"],
  options?: {
    preserveOwnerCodexEnvironmentMetadata?: boolean;
  },
): NavigationLaunchpadDraft {
  if (!current || current.directoryKey !== next.directoryKey) {
    return next;
  }

  const merged: NavigationLaunchpadDraft = { ...next };
  const backendChanged = "backend" in patch;
  const environmentChanged = backendChanged || "codexEnvironmentId" in patch;
  const preserveSetting = <Key extends keyof NavigationLaunchpadDraft>(
    key: Key,
  ): void => {
    const serverResolvesReasoningForModel =
      key === "reasoningEffort" && "model" in patch;
    if (
      !backendChanged
      && !(key in patch)
      && !serverResolvesReasoningForModel
    ) {
      merged[key] = current[key] as NavigationLaunchpadDraft[Key];
    }
  };
  const preserveEnvironment = <Key extends keyof NavigationLaunchpadDraft>(
    key: Key,
  ): void => {
    if (!environmentChanged && !(key in patch)) {
      merged[key] = current[key] as NavigationLaunchpadDraft[Key];
    }
  };

  preserveSetting("executionMode");
  preserveSetting("model");
  preserveSetting("reasoningEffort");
  preserveSetting("serviceTier");
  preserveSetting("fastMode");
  preserveSetting("workMode");
  preserveSetting("branchName");
  preserveSetting("federationTarget");
  preserveSetting("parentThreadId");
  preserveSetting("parentThreadBackend");
  preserveSetting("parentThreadInstanceId");
  preserveSetting("parentThreadTitle");
  preserveEnvironment("codexEnvironmentId");
  preserveEnvironment("codexEnvironmentExecutionTarget");
  preserveEnvironment("codexEnvironmentActionId");
  preserveEnvironment("codexEnvironmentOptions");

  if (options?.preserveOwnerCodexEnvironmentMetadata) {
    // Remote launchpad drafts are persisted on the viewer, but environment
    // discovery belongs to the owner. The viewer-side update response may
    // legitimately contain an empty environment list because the owner's
    // absolute project path does not exist on this machine. Keep the
    // owner-sourced metadata already held by the renderer while accepting the
    // viewer's persisted settings response for every other field.
    merged.codexEnvironmentId = current.codexEnvironmentId;
    merged.codexEnvironmentExecutionTarget =
      current.codexEnvironmentExecutionTarget;
    merged.codexEnvironmentActionId = current.codexEnvironmentActionId;
    merged.codexEnvironmentOptions = current.codexEnvironmentOptions;
  }

  return merged;
}

function applyLaunchpadReset(
  snapshot: NavigationLoadedRows | undefined,
  directoryKey: string,
  defaults: NavigationLaunchpadDefaults | undefined
): NavigationLoadedRows | undefined {
  if (!snapshot) {
    return snapshot;
  }

  return {
    ...snapshot,
    directoryRows: indexLoadedDirectoryRows(loadedDirectoryRows(snapshot).map((directory) =>
      directory.key === directoryKey ? { ...directory, launchpad: undefined } : directory
    )),
    launchpadDefaults: defaults,
  };
}

function projectOptimisticThreadIntoDirectories(
  directories: NavigationDirectorySummary[],
  optimisticThread?: NavigationThreadSummary,
): NavigationDirectorySummary[] {
  if (!optimisticThread) return directories;
  const nextDirectories = [...directories];
  for (const linkedDirectory of optimisticThread.linkedDirectories) {
    const descriptor = classifyDirectory(linkedDirectory);
    if (nextDirectories.some((directory) => directory.key === descriptor.key)) continue;
    // A newly accepted thread can reveal a project before its descriptor arrives.
    // Its population remains unknown until the owner query returns.
    nextDirectories.push({
      key: descriptor.key,
      kind: descriptor.kind,
      label: descriptor.label,
      path: descriptor.path,
    });
  }
  return nextDirectories.length === directories.length ? directories : sortNavigationDirectories(nextDirectories);
}

function getFallbackSelectionKey(
  response: NavigationLoadedRows,
  optimisticThreadKey?: string
): string | undefined {
  if (optimisticThreadKey) {
    return optimisticThreadKey;
  }

  if (loadedThreadRows(response)[0]) {
    return threadSummaryIdentityKey(loadedThreadRows(response)[0]);
  }

  const firstLaunchpadDirectory = loadedDirectoryRows(response).find((directory) => directory.launchpadPresent || directory.launchpad);
  return firstLaunchpadDirectory
    ? buildLaunchpadSelectionKey(firstLaunchpadDirectory.key)
    : undefined;
}

function buildOptimisticThreadFromLaunchpad(params: {
  directory?: NavigationDirectorySummary;
  launchpad: NavigationLaunchpadDraft;
  backend: AppServerBackendKind;
  threadId: string;
  executionMode: ThreadExecutionMode;
  workMode: NavigationLaunchpadDraft["workMode"];
  codexEnvironmentRuntime?: NavigationThreadSummary["codexEnvironmentRuntime"];
  optimisticUserMessage?: NavigationThreadSummary["optimisticUserMessage"];
  optimisticActiveTurn?: NavigationThreadSummary["optimisticActiveTurn"];
  parentThreadId?: string;
  parentThreadBackend?: AppServerBackendKind;
  parentThreadInstanceId?: string;
  pinnedRank?: string;
  scheduledStart?: NavigationThreadSummary["scheduledStart"];
  federation?: NavigationThreadSummary["federation"];
}): NavigationThreadSummary {
  const titlePrompt =
    params.optimisticUserMessage?.text?.trim() || params.launchpad.prompt.trim();
  const derivedTitle = shortenDerivedThreadTitle(titlePrompt);
  const agentName = params.launchpad.agent?.name.trim();
  const agentInstructions = params.launchpad.agent?.instructions?.trim();
  const agentInstructionLineCount = agentInstructions
    ? agentInstructions.split(/\r?\n/).length
    : 0;

  return {
    id: params.threadId,
    title: agentName || derivedTitle || "Untitled thread",
    titleSource: agentName ? "explicit" : derivedTitle ? "derived" : "fallback",
    summary: titlePrompt || undefined,
    projectKey: params.launchpad.directoryPath,
    source: params.backend,
    executionMode: params.executionMode,
    model: params.launchpad.model,
    reasoningEffort: params.launchpad.reasoningEffort,
    serviceTier: params.launchpad.serviceTier,
    fastMode: params.launchpad.fastMode,
    tokenMiserEnabled: params.launchpad.tokenMiserEnabled,
    ...(params.launchpad.agent
      ? {
          agent: {
            name: params.launchpad.agent.name,
            ...(agentInstructions ? { instructions: agentInstructions } : {}),
            instructionLineCount: agentInstructionLineCount,
            instructionsTooLong:
              agentInstructionLineCount > AGENT_PERSONA_INSTRUCTIONS_LINE_GUIDANCE,
            updatedAt: Date.now(),
          },
        }
      : {}),
    parentThreadId: params.parentThreadId,
    parentThreadBackend: params.parentThreadBackend,
    parentThreadInstanceId: params.parentThreadInstanceId,
    pinnedRank: params.pinnedRank,
    federation: params.federation,
    acpRuntime: params.launchpad.acpRuntime,
    codexEnvironmentRuntime: params.codexEnvironmentRuntime,
    optimisticUserMessage: params.optimisticUserMessage,
    optimisticActiveTurn: params.optimisticActiveTurn,
    scheduledStart: params.scheduledStart,
    linkedDirectories:
      params.launchpad.directoryPath && params.launchpad.directoryKind !== "workspace"
        ? [
            {
              id: `launchpad:${params.launchpad.directoryKey}`,
              label: params.launchpad.directoryLabel,
              path: params.launchpad.directoryPath,
              kind: params.workMode === "worktree" ? "worktree" : "local",
            },
          ]
        : [],
    gitBranch:
      params.workMode === "worktree"
        ? "HEAD"
        : params.directory?.gitStatus?.currentBranch ?? params.launchpad.branchName,
    observedGitBranch: params.workMode === "worktree" ? "HEAD" : undefined,
    updatedAt: Date.now(),
    inbox: {
      inInbox: true,
      reason: "new-thread",
    },
  };
}

function mergeHydratedThreadWithOptimisticTitle(
  thread: NavigationThreadSummary,
  optimisticThread: NavigationThreadSummary,
): NavigationThreadSummary {
  if (optimisticThread.titleSource === "fallback") {
    return thread;
  }

  if (!hasPlaceholderThreadTitle(thread)) {
    return thread;
  }

  return {
    ...thread,
    summary: thread.summary ?? optimisticThread.summary,
    title: optimisticThread.title,
    titleSource: optimisticThread.titleSource,
  };
}

function mergeHydratedThreadWithOptimisticState(
  thread: NavigationThreadSummary,
  optimistic: NavigationThreadSummary,
): NavigationThreadSummary {
  return { ...mergeHydratedThreadWithOptimisticTitle(thread, optimistic),
    codexEnvironmentRuntime: thread.codexEnvironmentRuntime ?? optimistic.codexEnvironmentRuntime,
    optimisticActiveTurn: thread.optimisticActiveTurn ?? optimistic.optimisticActiveTurn,
    optimisticUserMessage: thread.optimisticUserMessage ?? optimistic.optimisticUserMessage,
    pinnedRank: thread.pinnedRank ?? optimistic.pinnedRank,
    scheduledStart: thread.scheduledStart ?? optimistic.scheduledStart,
  };
}

function buildOptimisticUserMessage(
  input: AppServerTurnInputItem[] | undefined
): NavigationThreadSummary["optimisticUserMessage"] {
  if (!input?.length) {
    return undefined;
  }

  const text = input
    .filter((item): item is Extract<AppServerTurnInputItem, { type: "text" }> =>
      item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const imageParts: AppServerThreadImagePart[] = input
    .filter((item): item is Extract<AppServerTurnInputItem, { type: "image" }> =>
      item.type === "image" && typeof item.url === "string"
    )
    .map((item) => ({
      type: "image",
      url: item.url,
    }));

  if (!text && imageParts.length === 0) {
    return undefined;
  }

  return {
    text,
    ...(imageParts.length > 0 ? { imageParts } : {}),
    createdAt: Date.now(),
  };
}

function buildPendingForkEnvironmentSetup(params: {
  directoryLabel: string;
  directoryPath?: string | undefined;
  mode: ThreadWorkspaceMode;
  parent: NavigationThreadSummary;
  runtime?: CodexThreadEnvironmentRuntime | undefined;
}): PendingForkEnvironmentSetup | undefined {
  const { mode, runtime } = params;
  if (
    mode !== "new-worktree" ||
    runtime?.executionTarget !== "local" ||
    !runtime.setupCommand
  ) {
    return undefined;
  }

  return {
    backend: params.parent.source,
    command: runtime.setupCommand,
    directoryKey: `fork:${params.parent.source}:${params.parent.id}:${mode}`,
    directoryLabel: params.directoryLabel,
    environmentId: runtime.environmentId,
    environmentName: runtime.environmentName,
    ...(params.directoryPath ? { cwd: params.directoryPath } : {}),
  };
}

function reviewDisplayTextFromTarget(
  target: AppServerReviewTarget | undefined
): string | undefined {
  if (!target) {
    return undefined;
  }

  switch (target.type) {
    case "uncommittedChanges":
      return "Review current changes";
    case "baseBranch":
      return `Review changes against ${target.branch}`;
    case "commit":
      return `Review commit ${target.sha}`;
    case "custom":
      return "Review custom instructions";
  }
}

export type PendingLaunchpadCreation = {
  federatedSession?: FederatedLaunchpadSession;
  setupProgress?: LaunchpadEnvironmentSetupProgress;
  selectionKey: string;
  directoryKey: string;
  title: string;
  input: AppServerTurnInputItem[];
};

type UseThreadNavigationOptions = {
  enabled?: boolean;
  composerDraftStore?: ComposerDraftStore;
  attentionPromoteOnTurnEnd?: boolean;
  lightweightNavigationRefresh?: boolean;
  progressiveInitialRefresh?: boolean;
  threadViewVisible?: boolean;
  /**
   * Publishes create / rename / archive / discard failures to the app's
   * notice stack. A `message` of `undefined` means the slot cleared — the
   * next attempt started, or it succeeded — and the notice should come down.
   *
   * These actions used to render into a shared static slot at the top of the
   * sidebar, which had no dismiss, no timeout, a fixed priority order that
   * let one stale error mask the other four, and a permanent layout cost.
   */
  onThreadActionError?: (event: {
    kind: ThreadActionErrorKind;
    message?: string;
  }) => void;
};

export function useThreadNavigation(
  desktopApi?: DesktopApi,
  options: UseThreadNavigationOptions = {}
): {
  browseMode: BrowseMode;
  directoryDisclosure: NavigationDirectoryDisclosure;
  /** Identity key of the card to highlight as the open composer's source. */
  composerSourceThreadKey?: string;
  createThread: (
    backend?: AppServerBackendKind,
    executionMode?: ThreadExecutionMode,
    options?: { forceWorkspace?: boolean }
  ) => Promise<void>;
  createSubthread: (
    parent: NavigationThreadSummary,
    mode?: ThreadWorkspaceMode,
  ) => Promise<void>;
  /** Returns true when cancellation restores a sub-thread source selection. */
  discardLaunchpad: (directoryKey: string) => boolean;
  forkThread: (
    parent: NavigationThreadSummary,
    mode: ThreadWorkspaceMode,
  ) => Promise<void>;
  creatingThread?: CreatingThreadState;
  directories: NavigationDirectorySummary[];
  error?: string;
  /** Instance that owns the active navigation snapshot. */
  federationTarget?: FederationTarget;
  inboxThreads: NavigationThreadSummary[];
  recentThreads: NavigationThreadSummary[];
  launchpadError?: string;
  pendingLaunchpadCreations: PendingLaunchpadCreation[];
  selectPendingLaunchpad: (selectionKey: string) => void;
  archiveThreadNotice?: ArchiveThreadNotice;
  dismissArchiveThreadNotice: () => void;
  worktreeArchiveError?: string;
  loading: boolean;
  loaded: boolean;
  providerRefresh?: { state: "checking" | "degraded" | "ready"; failedProviders?: number };
  refreshing: boolean;
  refresh: () => Promise<void>;
  materializeDirectoryLaunchpad: (
    directoryKey: string,
    input?: AppServerTurnInputItem[],
    collaborationMode?: AppServerCollaborationModeRequest,
    reviewTarget?: AppServerReviewTarget,
    parentThreadId?: string,
    extraDirectoryPaths?: string[],
    scheduledFor?: number,
    onMaterialized?: (thread: NavigationThreadSummary) => void,
  ) => Promise<void>;
  /** Directory the New Thread button resolves to by default, or undefined for the directory-less workspace. */
  newThreadDirectoryLabel?: string;
  /** Directories available to the project picker for the active launchpad. */
  launchpadDirectories: NavigationDirectorySummary[];
  openDirectoryLaunchpad: (
    directory: NavigationDirectorySummary,
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  /** Open a project launchpad addressed to a remote federation instance. */
  openFederatedDirectoryLaunchpad: (
    target: FederationRemoteTarget,
    directory: NavigationDirectorySummary,
  ) => Promise<void>;
  /** Switch the composer to the directory-less ("workspace") launchpad. */
  openWorkspaceLaunchpad: (
    preferredBackend?: AppServerBackendKind
  ) => Promise<void>;
  /** Open a directory-free launchpad and populate its picker from a peer. */
  openFederatedWorkspaceLaunchpad: (
    target: FederationRemoteTarget,
  ) => Promise<void>;
  /** Project-directory picker (issue #223): OS dialog → validate → seed launchpad → focus it. */
  pickAndRegisterDirectory: (
    preferredBackend?: AppServerBackendKind,
  ) => Promise<void>;
  /** Register a user-curated project, keep the current selection, and reveal the Directories lens. */
  addProjectDirectory: () => Promise<void>;
  /** Existing-thread picker: OS dialog -> validate -> attach as an extra linked directory. */
  pickAndAttachDirectoryToSelectedThread: () => Promise<void>;
  /**
   * No-navigation variant of `pickAndRegisterDirectory` for the composer's
   * reference pickers ("@ → Add directory…", the "+" menu): OS dialog →
   * validate/register → fold the new launchpad into the snapshot so the
   * tracked set knows it, then resolve with the picked directory's
   * label/path for the caller to mint a chip. Never changes the selected
   * item. Resolves undefined on cancel or failure (failures also surface
   * via `pickDirectoryError`).
   */
  pickDirectoryForReference: () => Promise<
    { label: string; path: string } | undefined
  >;
  /**
   * Attach known directory paths (composer `@`-references) to a specific
   * thread. The target is explicit — the composer resolves it from the
   * turn it just sent — so a selection change while the turn request was
   * in flight (or a queued turn firing later) cannot link the directories
   * to the wrong thread. Per-path failures are non-fatal — the turn
   * already carries the path as text, so a failed link only loses the
   * sidebar association.
   */
  attachDirectoryPathsToThread: (
    target: {
      backend: AppServerBackendKind;
      federationTarget?: FederationTarget;
      threadId: string;
    },
    paths: string[],
  ) => Promise<void>;
  pickDirectoryError?: string;
  pickingDirectory: boolean;
  clearPickDirectoryError: () => void;
  resetDirectoryLaunchpad: (directoryKey: string) => Promise<void>;
  removeDirectory: (directoryKey: string) => Promise<void>;
  markDirectoriesSeen: (directoryKeys: string[]) => Promise<void>;
  /** Select an existing launchpad without creating or resetting its draft. */
  selectDirectoryLaunchpad: (directoryKey: string) => void;
  selectedDirectory?: NavigationDirectorySummary;
  selectedItemKey?: string;
  selectedLaunchpad?: NavigationLaunchpadDraft;
  selectedThread?: NavigationThreadSummary;
  selectedThreadConfigurationReady: boolean;
  selectedThreadConfigurationError?: string;
  refreshSelectedThreadConfiguration: () => Promise<void>;
  selectedThreadKey?: string;
  setThreadExecutionMode: (
    thread: NavigationThreadSummary,
    executionMode: ThreadExecutionMode
  ) => Promise<void>;
  setThreadExecutionModeError?: string;
  cancelThreadExecutionModeQueue: (
    thread: NavigationThreadSummary
  ) => Promise<void>;
  setAcpSessionRuntimeOption: (
    thread: NavigationThreadSummary,
    params: {
      source: "configOption" | "mode";
      optionId: string;
      value: string;
    }
  ) => Promise<void>;
  setThreadModelSettings: (
    thread: NavigationThreadSummary,
    patch: Partial<
      Pick<
      NavigationThreadSummary,
      "model" | "reasoningEffort" | "serviceTier" | "fastMode"
      >
    >
  ) => Promise<void>;
  setThreadPrAutoDispatch: (
    thread: NavigationThreadSummary,
    enabled: boolean,
  ) => Promise<void>;
  cancelThreadPrAutoDispatch: (
    thread: NavigationThreadSummary,
    fingerprint: string,
  ) => Promise<void>;
  sendThreadPrAutoDispatchNow: (
    thread: NavigationThreadSummary,
    fingerprint: string,
  ) => Promise<void>;
  setThreadModelSettingsError?: string;
  updatingThreadExecutionMode?: ThreadExecutionMode;
  updateDirectoryLaunchpad: (
    directoryKey: string,
    patch: Parameters<NonNullable<DesktopApi["updateDirectoryLaunchpad"]>>[0]["patch"],
    options?: { stickySettingsChanged?: boolean }
  ) => Promise<void>;
  setBrowseMode: (browseMode: BrowseMode) => void;
  selectThread: (thread: NavigationThreadSummary) => void;
  markThreadsSeen: (threads: NavigationThreadSummary[]) => Promise<void>;
  markThreadUnread: (thread: NavigationThreadSummary) => Promise<void>;
  showThread: (params: {
    backend: AppServerBackendKind;
    federationTarget?: FederationTarget;
    threadId: string;
  }) => Promise<void>;
  archiveThread: (
    thread: NavigationThreadSummary,
    options?: ArchiveThreadOptions,
  ) => Promise<void>;
  archiveWorktree: (
    thread: NavigationThreadSummary,
    directory: LinkedDirectorySummary
  ) => Promise<void>;
  restoreWorktree: (
    thread: NavigationThreadSummary,
    snapshotRef: string,
    worktreePath: string
  ) => Promise<void>;
  handoffThreadWorkspace: (
    thread: NavigationThreadSummary,
    request: Omit<HandoffThreadWorkspaceRequest, "backend" | "threadId">
  ) => Promise<void>;
  renameThread: (thread: NavigationThreadSummary, name: string) => Promise<void>;
  setThreadReaction: (
    thread: NavigationThreadSummary,
    emoji: string,
    present: boolean,
  ) => Promise<void>;
  setThreadPin: (
    thread: NavigationThreadSummary,
    pinned: boolean,
  ) => Promise<void>;
  setThreadAgent: (
    thread: NavigationThreadSummary,
    agent: Parameters<NonNullable<DesktopApi["setThreadAgent"]>>[0]["agent"],
  ) => Promise<void>;
  /**
   * Reorder pinned threads globally. `orderedThreadKeys` is the complete
   * pinned order across all backends (thread identity keys), top first.
   */
  reorderThreadPins: (orderedThreadKeys: string[], move?: NavigationRelativePinMove) => Promise<void>;
  setThreadParent: (
    thread: NavigationThreadSummary,
    parentThreadId?: string,
  ) => Promise<void>;
  unlinkThreads: (threads: NavigationThreadSummary[]) => Promise<void>;
  updateSubthreadOrder: (
    parent: NavigationThreadSummary,
    threadIds: string[],
  ) => Promise<void>;
  setSubthreadsCollapsed: (
    parent: NavigationThreadSummary,
    collapsed: boolean,
  ) => Promise<void>;
  /** Directory pin: optimistic patch → IPC → reconcile. Plan Unit J. */
  setDirectoryPin: (
    directory: NavigationDirectorySummary,
    pinned: boolean,
  ) => Promise<void>;
  reorderDirectoryPins: (directoryKeys: string[], move?: NavigationRelativePinMove) => Promise<void>;
  setDirectoryThreadsCollapsed: (
    directory: NavigationDirectorySummary,
    collapsed: boolean,
  ) => Promise<void>;
  loadedRows?: NavigationLoadedRows;
  pagedNavigation: ReturnType<typeof useBoundedNavigationWindow>;
  selectedLaunchpadConfigurationReady: boolean;
  threads: NavigationThreadSummary[];
} {
  const directoryDisclosure = useNavigationDirectoryDisclosure();
  const markThreadSeen = desktopApi?.markThreadSeen;
  const forkThreadRequest = desktopApi?.forkThread;
  const archiveThreadRequest = desktopApi?.archiveThread;
  const removeRemoteThreadPinRequest = desktopApi?.removeRemoteThreadPin;
  const archiveWorktreeRequest = desktopApi?.archiveWorktree;
  const restoreWorktreeRequest = desktopApi?.restoreWorktree;
  const handoffThreadWorkspaceRequest = desktopApi?.handoffThreadWorkspace;
  const renameThreadRequest = desktopApi?.renameThread;
  const setThreadExecutionMode = desktopApi?.setThreadExecutionMode;
  const setAcpSessionRuntimeOption = desktopApi?.setAcpSessionRuntimeOption;
  const cancelThreadExecutionModeQueueRequest =
    desktopApi?.cancelThreadExecutionModeQueue;
  const setThreadModelSettings = desktopApi?.setThreadModelSettings;
  const setThreadPrAutoDispatchRequest = desktopApi?.setThreadPrAutoDispatch;
  const cancelThreadPrAutoDispatchRequest =
    desktopApi?.cancelThreadPrAutoDispatch;
  const sendThreadPrAutoDispatchNowRequest =
    desktopApi?.sendThreadPrAutoDispatchNow;
  const setNavigationBrowseModeRequest = desktopApi?.setNavigationBrowseMode;
  const enabled = options.enabled ?? true;
  const rendererFederationTarget = useMemo(readRendererFederationTarget, []);
  const isRendererFederationWindow = Boolean(rendererFederationTarget);
  const lightweightNavigationRefresh = options.lightweightNavigationRefresh ?? false;
  const threadViewVisible = options.threadViewVisible ?? true;
  const [browseMode, setBrowseMode] = useState<BrowseMode>(readBridgedBrowseMode);
  const [selectedItemKey, setSelectedItemKey] = useState<string>();
  const initialSelectionEstablishedRef = useRef(false);
  const [pendingSeenThreadKey, setPendingSeenThreadKey] = useState<string>();
  const [retainedUnreadThread, setRetainedUnreadThread] =
    useState<NavigationThreadSummary>();
  const [optimisticThread, setOptimisticThread] = useState<NavigationThreadSummary>();
  const [creatingThread, setCreatingThread] = useState<CreatingThreadState>();
  const [localLaunchpads, setLocalLaunchpads] = useState<
    Record<string, NavigationLaunchpadDraft>
  >({});
  const [federatedLaunchpad, setFederatedLaunchpad] = useState<
    FederatedLaunchpadSession
  >();
  // A peer snapshot and the subsequent launchpad ensure both cross the
  // network. Keep only the most recent launch intent so a slow prior peer or
  // project selection cannot replace the launchpad the operator just chose.
  const federatedLaunchpadOpenRevisionRef = useRef(0);
  // Create / rename / archive keep their single error slot here — every
  // producer already clears it when the next attempt starts — but the slot
  // is now published to the notice stack instead of rendered inline. See
  // `onThreadActionError`.
  const [createThreadError, setCreateThreadError] = useState<string>();
  const [launchpadError, setLaunchpadError] = useState<string>();
  const pendingLaunchpadCreationsRef = useRef(new Map<string, PendingLaunchpadCreation>());
  const [pendingLaunchpadCreations, setPendingLaunchpadCreations] =
    useState<PendingLaunchpadCreation[]>([]);
  useEffect(() => desktopApi?.onCodexEnvironmentSetupProgress?.((event) => {
    let changed = false;
    for (const [key, creation] of pendingLaunchpadCreationsRef.current) {
      if (creation.directoryKey !== event.directoryKey) continue;
      pendingLaunchpadCreationsRef.current.set(key, {
        ...creation,
        setupProgress: applyLaunchpadEnvironmentSetupProgress(creation.setupProgress, event),
      });
      changed = true;
    }
    if (changed) setPendingLaunchpadCreations([...pendingLaunchpadCreationsRef.current.values()]);
  }), [desktopApi]);
  const [archiveThreadError, setArchiveThreadError] = useState<string>();
  const [archiveThreadNotice, setArchiveThreadNotice] = useState<ArchiveThreadNotice>();
  const [worktreeArchiveError, setWorktreeArchiveError] = useState<string>();
  const [renameThreadError, setRenameThreadError] = useState<string>();
  // Held in a ref so a caller that rebuilds the callback every render cannot
  // re-fire the publish effects below on an unchanged message.
  const onThreadActionErrorRef = useRef(options.onThreadActionError);
  useEffect(() => {
    onThreadActionErrorRef.current = options.onThreadActionError;
  }, [options.onThreadActionError]);
  useEffect(() => {
    onThreadActionErrorRef.current?.({
      kind: "create-thread",
      message: createThreadError,
    });
  }, [createThreadError]);
  useEffect(() => {
    onThreadActionErrorRef.current?.({
      kind: "archive-thread",
      message: archiveThreadError,
    });
  }, [archiveThreadError]);
  useEffect(() => {
    onThreadActionErrorRef.current?.({
      kind: "rename-thread",
      message: renameThreadError,
    });
  }, [renameThreadError]);
  // Discard has no slot of its own. `discardLaunchpad` clears the selection
  // before it persists the discard, so the launchpad composer that renders
  // `launchpadError` is already unmounted when the persistence call rejects —
  // the message would land on a surface nobody is looking at (or, worse, on
  // the next unrelated launchpad the operator opens). Publish it directly.
  const publishDiscardLaunchpadError = useCallback((error?: unknown): void => {
    onThreadActionErrorRef.current?.({
      kind: "discard-launchpad",
      message:
        error === undefined
          ? undefined
          : error instanceof Error
            ? error.message
            : String(error),
    });
  }, []);
  // Same shape for the masthead's "Add project directory" entry. It lives in
  // the sidebar / title bar, and `pickDirectoryError`'s only inline surface is
  // the launchpad composer's project picker — not mounted behind that menu, so
  // a rejected pick ("not a git repository") would land nowhere. The ref
  // carries what `pickDirectoryForReference` last recorded, since the state
  // setter cannot be read back inside the same call.
  const lastPickDirectoryErrorRef = useRef<string>(undefined);
  const publishAddDirectoryError = useCallback((message?: string): void => {
    onThreadActionErrorRef.current?.({ kind: "add-directory", message });
  }, []);
  const [updatingThreadExecutionMode, setUpdatingThreadExecutionMode] =
    useState<ThreadExecutionMode>();
  const [setThreadExecutionModeError, setSetThreadExecutionModeError] =
    useState<string>();
  const [setThreadModelSettingsError, setSetThreadModelSettingsError] =
    useState<string>();
  // Project-directory picker (issue #223). `pickAndRegisterDirectory`
  // bridges the OS dialog → register flow; while it's in flight we
  // disable the picker's "Add directory…" row, and any validation
  // failure surfaces inline via `pickDirectoryError`. Both reset on the
  // next attempt rather than persisting between renders.
  const [pickDirectoryError, setPickDirectoryError] = useState<string>();
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [state, setState] = useState<NavigationState>({
    loading: enabled,
    refreshing: false,
  });
  const [viewForeground, setViewForeground] = useState(isRendererViewForeground);
  const prChipLocationIndexRef = useRef<PrChipLocationIndex | undefined>(undefined);

  const optimisticThreadRef = useRef<NavigationThreadSummary | undefined>(undefined);
  const retainedUnreadThreadRef = useRef<NavigationThreadSummary | undefined>(undefined);
  const selectedItemKeyRef = useRef<string | undefined>(undefined);
  const manuallySelectedThreadKeysRef = useRef(new Set<string>());
  const submittedSeenUpdatedAtByThreadKeyRef = useRef(new Map<string, number | undefined>());
  const refreshInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const actionAbortControllerRef = useRef(new AbortController());
  const queuedRefreshRef = useRef<
    | {
        forceRefresh?: boolean;
        forcePreferredSelection?: boolean;
        preferredOptimisticThread?: NavigationThreadSummary;
        preferredSelectionKey?: string;
        refreshMode?: "active-recent" | "full";
      }
    | undefined
  >(undefined);
  const suppressedArchivedThreadKeysRef = useRef<Set<string>>(new Set());
  const removedDirectoryKeysRef = useRef(new Set<string>());
  const scheduledRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const scheduledFocusRefreshTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const focusRefreshInFlightRef = useRef(false);
  const focusRefreshQueuedRef = useRef(false);
  const lastFocusRefreshCompletedAtRef = useRef(0);
  const remotePeerDisconnectedRef = useRef(false);
  const remoteDirectoryThreadsCollapsedOverridesRef = useRef(
    new Map<string, boolean>(),
  );
  const lastNavigationActivityAtRef = useRef(Date.now());
  const backgroundRefreshIdleRef = useRef(false);
  const launchpadUpdateRevisionRef = useRef(new Map<string, number>());
  const pendingPickedLaunchpadRef = useRef(new Map<string, NavigationLaunchpadDraft>());
  const pendingDirectoryGitStatusRef = useRef(
    new Map<string, NavigationDirectoryGitStatus | null>(),
  );
  // A newly-created thread can be named by the helper before the materialize
  // IPC response gives the renderer an optimistic row to update. Retain the
  // authoritative event so that response and a stale first refresh cannot
  // put "Untitled thread" back over the generated name.
  const threadNameObservationsRef = useRef(
    new Map<string, ThreadNameObservation>(),
  );
  const setNavigationBrowseModeRequestRef = useRef(setNavigationBrowseModeRequest);
  const stateRef = useRef(state);


  optimisticThreadRef.current = optimisticThread;
  retainedUnreadThreadRef.current = retainedUnreadThread;
  selectedItemKeyRef.current = selectedItemKey;
  stateRef.current = state;

  useEffect(() => {
    mountedRef.current = true;
    if (actionAbortControllerRef.current.signal.aborted) actionAbortControllerRef.current = new AbortController();
    return () => {
      actionAbortControllerRef.current.abort();
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setNavigationBrowseModeRequestRef.current = setNavigationBrowseModeRequest;
  }, [setNavigationBrowseModeRequest]);

  const updateBrowseMode = useCallback((nextBrowseMode: BrowseMode): void => {
    const normalized = normalizeBrowseMode(nextBrowseMode);
    setBrowseMode(normalized);
    void setNavigationBrowseModeRequestRef.current?.({
      browseMode: normalized,
    }).catch(() => undefined);
  }, []);

  const releaseRetainedUnreadThread = useCallback((nextSelectionKey?: string): void => {
    const retainedThread = retainedUnreadThreadRef.current;
    if (!retainedThread) {
      return;
    }

    const retainedThreadKey = threadSummaryIdentityKey(retainedThread);
    if (nextSelectionKey === retainedThreadKey) {
      return;
    }

    setState((current) => ({
      ...current,
      rows: markThreadSeenInLoadedRows(current.rows, {
        backend: retainedThread.source,
        federationTarget: retainedThread.federation?.ref.target,
        threadId: retainedThread.id,
        seenUpdatedAt: retainedThread.updatedAt,
      }),
    }));
    setRetainedUnreadThread(undefined);
  }, []);

  const attentionViewId = useId();
  const selectedIdentity = selectedItemKey
    ? navigationIdentityFromThreadKey(selectedItemKey, rendererFederationTarget)
    : undefined;
  const selectedDetail = useNavigationSelectedDetail({
    desktopApi, enabled: enabled && viewForeground,
    ref: selectedIdentity,
    federationTarget: selectedIdentity?.ownerInstanceId
      ? { scope: "remote", instanceId: selectedIdentity.ownerInstanceId }
      : undefined,
  });
  const launchpadConfiguration = useNavigationLaunchpadConfiguration({ desktopApi, enabled,
    directoryKey: getDirectoryKeyFromLaunchpadSelection(selectedItemKey), federationTarget: rendererFederationTarget,
  });
  const draftStore = options.composerDraftStore;
  const draftVersion = useSyncExternalStore(
    useCallback((listener: () => void) => draftStore?.subscribeDraftPresence(listener) ?? (() => undefined), [draftStore]),
    useCallback(() => draftStore?.getDraftPresenceVersion() ?? 0, [draftStore]),
  );
  const draftRefs = useMemo(() => (draftStore?.getDraftScopeKeys() ?? []).flatMap((scope) => {
    const owner = parseOwnedComposerScopeKey(scope);
    if (!owner || (rendererFederationTarget && !federationTargetsEqual(owner.target, rendererFederationTarget))) return [];
    return [{ backend: owner.backend, threadId: owner.threadId,
      ...(owner.target.scope === "remote" ? { ownerInstanceId: owner.target.instanceId } : {}) }];
  }), [draftStore, draftVersion, rendererFederationTarget]);
  const selectedConfiguration = selectedDetail.state?.detail?.thread;
  const selectedDirectoryKeys = selectedConfiguration?.linkedDirectories.map((directory) => classifyDirectory(directory).key)
    ?? (getDirectoryKeyFromLaunchpadSelection(selectedItemKey) ? [getDirectoryKeyFromLaunchpadSelection(selectedItemKey)!] : []);
  const boundedNavigation = useBoundedNavigationWindow({ desktopApi, enabled, visible: viewForeground, observeEvents: false,
    browseMode, target: rendererFederationTarget, attentionView: { id: attentionViewId, promoteOnTurnEnd: options.attentionPromoteOnTurnEnd ?? true },
    expandedByKey: directoryDisclosure.expandedByKey, unpinnedExpandedByKey: directoryDisclosure.unpinnedExpandedByKey,
    selectedRef: selectedIdentity, selectedDirectoryKeys, removedDirectoryKeys: [...removedDirectoryKeysRef.current],
    disclosedParents: loadedThreadRows(state.rows).filter((thread) => !thread.subthreadsCollapsed && Boolean(thread.ordinaryChildCount))
      .map((thread) => ({ backend: thread.source, threadId: thread.id,
        ...(thread.federation?.ref.target.scope === "remote" ? { ownerInstanceId: thread.federation.ref.target.instanceId } : {}) })),
    draftRefs,
  });
  const acceptedPagesRef = useRef(new Map<string, unknown>());
  const acceptedDefaultsRef = useRef<unknown>(undefined);
  const acceptedDraftHydrationRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const pages = new Map([...boundedNavigation.resources].flatMap(([id, resource]) => resource.state.page ? [[id, resource.state.page] as const] : []));
    const changed = pages.size !== acceptedPagesRef.current.size
      || [...pages].some(([id, page]) => acceptedPagesRef.current.get(id) !== page)
      || acceptedDefaultsRef.current !== launchpadConfiguration.value
      || acceptedDraftHydrationRef.current !== draftStore?.hydrationVersion;
    const resources = [...boundedNavigation.resources.values()];
    const error = boundedNavigation.connectionError ?? boundedNavigation.admissionError ?? resources.find((resource) => resource.state.error)?.state.error;
    const refreshing = resources.some((resource) => resource.loading);
    const primary = resources.filter((resource) => browseMode === "directories" ? resource.id === "directory-index"
      : browseMode === "drafts" ? resource.id.startsWith("drafts:") : resource.id === "lens");
    const loading = enabled && primary.some((resource) => !resource.state.page && !resource.state.error);
    if (changed && pages.size) {
      const changedPages = [...pages].filter(([id, page]) => acceptedPagesRef.current.get(id) !== page);
      const retainedKeys = new Set([...pages.values()].flatMap((page) => page.entries.map(({ row }) => threadSummaryIdentityKey(row))));
      acceptedPagesRef.current = pages;
      acceptedDefaultsRef.current = launchpadConfiguration.value;
      acceptedDraftHydrationRef.current = draftStore?.hydrationVersion;
      const directoryRows = indexLoadedDirectoryRows(boundedNavigation.directories.filter((directory) => !removedDirectoryKeysRef.current.has(directory.key)).map((directory) => ({ ...directory,
        ...(launchpadConfiguration.value?.directoryKey === directory.key && launchpadConfiguration.value.directoryGitStatus
          ? { gitStatus: launchpadConfiguration.value.directoryGitStatus } : {}),
        ...(launchpadConfiguration.value?.directoryKey === directory.key && launchpadConfiguration.value.launchpad
          ? { launchpad: { ...launchpadConfiguration.value.launchpad,
              prompt: draftStore?.get(`launchpad:${directory.key}`)?.draft ?? "",
              imageAttachments: draftStore?.get(`launchpad:${directory.key}`)?.imageAttachments,
              fileAttachments: draftStore?.get(`launchpad:${directory.key}`)?.fileAttachments } } : {}),
      })));
      setState((current) => {
        // Unchanged resource pages must not roll back canonical row events or
        // resurrect tombstones when another resource finishes loading.
        const threadRows = new Map([...current.rows?.threadRows ?? []].filter(([key]) => retainedKeys.has(key)));
        // Local query resources own viewer pin ranks. Remote exact context
        // supplies thread metadata but cannot import the owner's pin order.
        const orderedPages = [...changedPages].sort(([left], [right]) =>
          Number(boundedNavigation.resources.get(left)?.state.request.federationTarget?.scope !== "remote")
          - Number(boundedNavigation.resources.get(right)?.state.request.federationTarget?.scope !== "remote"));
        const remoteContextKeys = new Set([...boundedNavigation.resources.values()]
          .filter((resource) => resource.state.request.federationTarget?.scope === "remote")
          .flatMap((resource) => resource.state.page?.entries.map(({ row }) => threadSummaryIdentityKey(row)) ?? []));
        for (const [id, page] of orderedPages) for (const { row } of page.entries) {
          const key = threadSummaryIdentityKey(row);
          const ownerPage = boundedNavigation.resources.get(id)?.state.request.federationTarget?.scope === "remote";
          const previous = threadRows.get(key);
          const presentedRow = rendererFederationTarget?.scope !== "remote" && row.ref.ownerInstanceId
            ? ownerPage ? { ...row, pinnedRank: previous?.pinnedRank }
              : previous && remoteContextKeys.has(key) ? { ...previous, pinnedRank: row.pinnedRank } : row
            : row;
          if (!suppressedArchivedThreadKeysRef.current.has(key)) threadRows.set(key, presentedRow);
        }
        for (const key of suppressedArchivedThreadKeysRef.current) threadRows.delete(key);
        const nextDirectoryRows = new Map(directoryRows);
        const selectedDirectoryKey = getDirectoryKeyFromLaunchpadSelection(selectedItemKeyRef.current);
        const previousOwner = current.rows?.federationTarget?.scope === "remote" ? current.rows.federationTarget.instanceId : undefined;
        const currentOwner = rendererFederationTarget?.scope === "remote" ? rendererFederationTarget.instanceId : undefined;
        if (selectedDirectoryKey && previousOwner === currentOwner && !removedDirectoryKeysRef.current.has(selectedDirectoryKey)) {
          const previous = current.rows?.directoryRows.get(selectedDirectoryKey);
          const descriptor = nextDirectoryRows.get(selectedDirectoryKey);
          if (previous) nextDirectoryRows.set(selectedDirectoryKey, descriptor
            ? { ...previous, ...descriptor, gitStatus: descriptor.gitStatus ? { ...previous.gitStatus, ...descriptor.gitStatus } : previous.gitStatus }
            : previous);
        }
        const next: NavigationLoadedRows = { threadRows, directoryRows: nextDirectoryRows,
          launchpadDefaults: launchpadConfiguration.value?.defaults, federationTarget: rendererFederationTarget };
        const reconciled = reconcileLoadedNavigationRows(current.rows, next);
        if (!prChipLocationIndexRef.current || !samePrChipMembership(prChipLocationIndexRef.current.snapshot, reconciled)) {
          prChipLocationIndexRef.current = buildPrChipLocationIndex(reconciled);
        }
        return { loading, refreshing, error, rows: reconciled,
          startupSelectionSettled: pages.get("directory-index")?.coverage.state === "complete" };
      });
    } else {
      setState((current) => ({ ...current, loading, refreshing, error }));
    }
  }, [boundedNavigation.resources, boundedNavigation.directories, boundedNavigation.admissionError, boundedNavigation.connectionError, launchpadConfiguration.value, rendererFederationTarget, enabled, browseMode, draftStore]);

  const performRefresh = useCallback(async (
    preferredSelectionKey?: string, preferredOptimisticThread?: NavigationThreadSummary, forcePreferredSelection = false,
    _options?: NavigationRefreshOptions,
  ): Promise<void> => {
    if (preferredOptimisticThread) setOptimisticThread(preferredOptimisticThread);
    if (preferredSelectionKey) setSelectedItemKey((current) => forcePreferredSelection || !current ? preferredSelectionKey : current);
    await boundedNavigation.refresh();
  }, [boundedNavigation.refresh]);

  const refresh = useCallback(
    async (
      preferredSelectionKey?: string,
      preferredOptimisticThread?: NavigationThreadSummary,
      forcePreferredSelection = false,
      options?: NavigationRefreshOptions
    ): Promise<void> => {
      const initialRequest = {
        forceRefresh: options?.forceRefresh === true,
        forcePreferredSelection,
        preferredOptimisticThread,
        preferredSelectionKey,
        refreshMode: options?.refreshMode,
      };

      if (refreshInFlightRef.current) {
        queuedRefreshRef.current = initialRequest;
        return;
      }

      refreshInFlightRef.current = true;
      let nextRequest: typeof initialRequest | undefined = initialRequest;

      try {
        while (nextRequest) {
          queuedRefreshRef.current = undefined;
          await performRefresh(
            nextRequest.preferredSelectionKey,
            nextRequest.preferredOptimisticThread,
            nextRequest.forcePreferredSelection,
            {
              forceRefresh: nextRequest.forceRefresh,
              refreshMode: nextRequest.refreshMode,
            }
          );
          nextRequest = queuedRefreshRef.current;
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    },
    [performRefresh]
  );
  const refreshNavigation = useCallback(async (): Promise<void> => {
    await Promise.all([refresh(), selectedDetail.refresh(), launchpadConfiguration.refresh()]);
  }, [refresh, selectedDetail.refresh, launchpadConfiguration.refresh]);

  const takePendingDirectoryGitStatus = useCallback(
    (directoryKey: string): NavigationDirectoryGitStatus | null | undefined => {
      if (!pendingDirectoryGitStatusRef.current.has(directoryKey)) {
        return undefined;
      }
      const gitStatus = pendingDirectoryGitStatusRef.current.get(directoryKey);
      pendingDirectoryGitStatusRef.current.delete(directoryKey);
      return gitStatus ?? null;
    },
    [],
  );

  const scheduleRefresh = useCallback(
    (
      preferredSelectionKey?: string,
      preferredOptimisticThread?: NavigationThreadSummary,
      forcePreferredSelection = false,
      options?: NavigationRefreshOptions
    ): void => {
      queuedRefreshRef.current = {
        forceRefresh:
          options?.forceRefresh === true || queuedRefreshRef.current?.forceRefresh === true,
        forcePreferredSelection,
        preferredOptimisticThread,
        preferredSelectionKey,
        refreshMode:
          options?.refreshMode === "full" ||
          queuedRefreshRef.current?.refreshMode === "full"
            ? "full"
            : options?.refreshMode ?? queuedRefreshRef.current?.refreshMode,
      };

      if (scheduledRefreshTimerRef.current !== undefined) {
        return;
      }

      scheduledRefreshTimerRef.current = setTimeout(() => {
        scheduledRefreshTimerRef.current = undefined;
        const nextRequest = queuedRefreshRef.current;
        queuedRefreshRef.current = undefined;
        if (!nextRequest) {
          return;
        }

        void refresh(
          nextRequest.preferredSelectionKey,
          nextRequest.preferredOptimisticThread,
          nextRequest.forcePreferredSelection,
          {
            forceRefresh: nextRequest.forceRefresh,
            refreshMode: nextRequest.refreshMode,
          }
        );
      }, 0);
    },
    [refresh]
  );

  const scheduleFocusRefresh = useCallback((): void => {
    if (focusRefreshInFlightRef.current) {
      focusRefreshQueuedRef.current = true;
      return;
    }

    if (scheduledFocusRefreshTimerRef.current !== undefined) {
      focusRefreshQueuedRef.current = true;
      return;
    }

    const elapsedSinceLastCompletion =
      Date.now() - lastFocusRefreshCompletedAtRef.current;
    const delayMs = Math.max(
      0,
      NAVIGATION_FOCUS_REFRESH_MIN_INTERVAL_MS - elapsedSinceLastCompletion,
    );

    const runRefresh = () => {
      scheduledFocusRefreshTimerRef.current = undefined;
      focusRefreshQueuedRef.current = false;
      focusRefreshInFlightRef.current = true;
      void refresh(undefined, undefined, false, {
        forceRefresh: true,
        refreshMode: "full",
      }).finally(() => {
        focusRefreshInFlightRef.current = false;
        lastFocusRefreshCompletedAtRef.current = Date.now();
        if (focusRefreshQueuedRef.current) {
          scheduleFocusRefresh();
        }
      });
    };

    if (delayMs === 0) {
      runRefresh();
      return;
    }

    focusRefreshQueuedRef.current = true;
    scheduledFocusRefreshTimerRef.current = setTimeout(runRefresh, delayMs);
  }, [refresh]);

  const markNavigationActivity = useCallback(
    (options: { refreshOnIdleResume?: boolean } = {}): void => {
      const wasIdle = backgroundRefreshIdleRef.current;
      lastNavigationActivityAtRef.current = Date.now();
      backgroundRefreshIdleRef.current = false;

      if (!wasIdle || options.refreshOnIdleResume === false) {
        return;
      }

      if (
        !enabled ||
        !desktopApi?.getNavigationQueryPage ||
        !isRendererViewForeground()
      ) {
        return;
      }

      scheduleRefresh(undefined, undefined, false, {
        forceRefresh: true,
        refreshMode: lightweightNavigationRefresh ? "active-recent" : undefined,
      });
    },
    [
      desktopApi?.getNavigationQueryPage,
      enabled,
      lightweightNavigationRefresh,
      scheduleRefresh,
    ]
  );

  useEffect(() => {
    return () => {
      if (scheduledRefreshTimerRef.current !== undefined) {
        clearTimeout(scheduledRefreshTimerRef.current);
      }
      if (scheduledFocusRefreshTimerRef.current !== undefined) {
        clearTimeout(scheduledFocusRefreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const updateForegroundState = () => {
      setViewForeground(isRendererViewForeground());
    };

    updateForegroundState();
    window.addEventListener("focus", updateForegroundState);
    window.addEventListener("blur", updateForegroundState);
    document.addEventListener("visibilitychange", updateForegroundState);

    return () => {
      window.removeEventListener("focus", updateForegroundState);
      window.removeEventListener("blur", updateForegroundState);
      document.removeEventListener("visibilitychange", updateForegroundState);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleNavigationActivity = () => {
      markNavigationActivity();
    };

    for (const eventName of NAVIGATION_ACTIVITY_EVENTS) {
      window.addEventListener(eventName, handleNavigationActivity, { capture: true });
    }

    return () => {
      for (const eventName of NAVIGATION_ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, handleNavigationActivity, {
          capture: true,
        });
      }
    };
  }, [markNavigationActivity]);

  useEffect(() => {
    if (
      !enabled ||
      !desktopApi?.getNavigationQueryPage ||
      !viewForeground
    ) {
      return;
    }

    const timer = setInterval(() => {
      const idleMs = Date.now() - lastNavigationActivityAtRef.current;
      if (idleMs >= NAVIGATION_BACKGROUND_REFRESH_IDLE_AFTER_MS) {
        backgroundRefreshIdleRef.current = true;
        return;
      }

      scheduleRefresh(undefined, undefined, false, {
        forceRefresh: true,
        refreshMode: lightweightNavigationRefresh ? "active-recent" : undefined,
      });
    }, NAVIGATION_BACKGROUND_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [
    desktopApi?.getNavigationQueryPage,
    enabled,
    lightweightNavigationRefresh,
    scheduleRefresh,
    viewForeground,
  ]);

  useEffect(() => {
    if (!enabled || !desktopApi?.onWindowFocus) {
      return;
    }

    return desktopApi.onWindowFocus(() => {
      markNavigationActivity({ refreshOnIdleResume: false });
      if (lightweightNavigationRefresh) {
        scheduleFocusRefresh();
        return;
      }
      scheduleRefresh();
    });
  }, [
    desktopApi,
    enabled,
    lightweightNavigationRefresh,
    markNavigationActivity,
    scheduleFocusRefresh,
    scheduleRefresh,
  ]);

  useEffect(() => {
    if (!enabled || !desktopApi?.onAgentEvent) {
      return;
    }

    return desktopApi.onAgentEvent((event) => {
      const windowTarget = readRendererFederationTarget();
      const method = event.notification.method as string;
      if (federationTargetsEqual(event.federationTarget, windowTarget) && navigationQueryEventRequiresRefresh(method)) {
        boundedNavigation.invalidate();
        // These notifications contain the complete replacement for every
        // affected chip. Keep the patched baseline stale for the next query,
        // without reading a new page for each working-state probe.
        if (method !== "navigation/threadGitWorkingState/updated" && method !== "navigation/directoryGitStatus/updated") {
          scheduleRefresh();
        }
      }
      if (method === "navigation/thread/seen" && federationTargetsEqual(event.federationTarget, windowTarget)) {
        const params = event.notification.params as { threadId: string; seenUpdatedAt?: number };
        setState((current) => ({ ...current, rows: markThreadSeenInLoadedRows(current.rows, {
          backend: event.backend, federationTarget: event.federationTarget, ...params,
        }) }));
        return;
      }
      if (method === "navigation/directory/seen") {
        scheduleRefresh();
        return;
      }
      if (method === "navigation/directory/removed") {
        scheduleRefresh();
        return;
      }
      // A peer's row-state events carry its own remote target, which never
      // matches the main window's absent target — yet this window
      // hosts that peer's threads as viewer-side remote pins. Let row-state
      // and lifecycle updates past the target filter and into their
      // origin-scoped appliers below.
      //
      // Safe against duelling monitors: the main process drops a peer
      // observation for any PR this instance monitors itself, so whatever
      // arrives here has no local poller to contradict. When we do own the
      // PR, our own local event patches the pinned row instead — status
      // updates match by prKey across every thread in the snapshot.
      const remoteThreadStatePassthrough =
        !windowTarget
        && Boolean(event.federationTarget)
        && (method === "pullRequest/status/updated"
          || method === "thread/pullRequests/updated"
          || method === "thread/reactions/updated"
          || method === "thread/prAutoDispatch/pendingUpdated"
          || method === "thread/prAutoDispatch/updated"
          || method === "thread/status/changed"
          || method === "turn/cancelled"
          || method === "turn/completed"
          || method === "turn/failed"
          || method === "thread/parent/set"
          || method === "thread/parent/cleared"
          || method === "thread/subthreadOrder/updated"
          || method === "thread/subthreadsCollapsed/updated");
      if (remoteThreadStatePassthrough && navigationQueryEventRequiresRefresh(method)) {
        // Viewer pages also contain mounted remote identities. A peer event
        // invalidates their in-flight baseline before its canonical patch lands.
        boundedNavigation.invalidate();
        scheduleRefresh();
      }
      if (
        !remoteThreadStatePassthrough
        && !federationTargetsEqual(event.federationTarget, windowTarget)
      ) {
        // Peer-status events are stamped with the peer's own remote target,
        // which never matches the main window's (absent) window target. The
        // main window still hosts that peer's threads via viewer-side remote
        // pins, so let those events through to dim/refresh the pinned rows.
        if (method !== "federation/peerStatus/changed" || windowTarget) {
          return;
        }
        const params = event.notification.params as {
          instanceId: string;
          status: string;
        };
        const status = params.status as FederationPeerSummary["status"];
        markNavigationActivity({ refreshOnIdleResume: false });
        setState((current) => ({
          ...current,
          rows: applyFederationPeerStatusUpdate(
            current.rows,
            params.instanceId,
            status,
          ),
        }));
        if (params.status === "connected") {
          scheduleRefresh(undefined, undefined, false, {
            forceRefresh: true,
            refreshMode: "full",
          });
          return;
        }
        return;
      }

      markNavigationActivity({ refreshOnIdleResume: false });
      if (method === "navigation/providerThreads/refreshed") {
        // Startup served the durable provider snapshot first. The background
        // revalidation has now populated the registry caches, so consume that
        // publication without forcing a second provider walk.
        scheduleRefresh();
        return;
      }
      if (method === "navigation/remoteThreadPins/changed") {
        // Viewer-side pin membership or rank changed (possibly in another
        // window) — the merged snapshot is the source of truth for the row
        // set, so refresh rather than patch.
        scheduleRefresh();
        return;
      }
      if (method === "federation/peerStatus/changed") {
        const params = event.notification.params as {
          instanceId: string;
          status: string;
          unavailableReason?: string;
        };
        const status = params.status as FederationPeerSummary["status"];
        if (params.status === "connected") {
          remotePeerDisconnectedRef.current = false;
          setState((current) => ({
            ...current,
            rows: applyFederationPeerStatusUpdate(
              current.rows,
              params.instanceId,
              status,
            ),
          }));
          // The bounded window owns this remote connection lifetime and
          // resumes its resources exactly once, even for duplicate events.
          return;
        }
        remotePeerDisconnectedRef.current = true;
        setState((current) => ({
          ...current,
          // Patch the live peer status onto the affected rows so surfaces
          // keyed off it (the remote terminal toggle) disable immediately
          // instead of waiting for the next snapshot refresh.
          rows: applyFederationPeerStatusUpdate(
            current.rows,
            params.instanceId,
            status,
          ),
          loading: false,
          refreshing: false,
          error: params.unavailableReason ??
            `Federation peer ${params.instanceId} is ${params.status}.`,
        }));
        return;
      }
      if (method === "navigation/directoryGitStatus/updated") {
        const params = event.notification
          .params as NavigationDirectoryGitStatusUpdatedNotification["params"];
        const hasDirectoryNow = loadedDirectoryRows(stateRef.current.rows).some(
          (directory) => directory.key === params.directoryKey,
        ) ?? false;
        if (!hasDirectoryNow) {
          pendingDirectoryGitStatusRef.current.set(
            params.directoryKey,
            params.gitStatus,
          );
        }
        setState((current) => {
          const hasDirectory = loadedDirectoryRows(current.rows).some(
            (directory) => directory.key === params.directoryKey,
          ) ?? false;
          if (!hasDirectory) {
            return current;
          }
          pendingDirectoryGitStatusRef.current.delete(params.directoryKey);
          return {
            ...current,
            rows: applyDirectoryGitStatusUpdate(current.rows, params),
          };
        });
        return;
      }

      if (method === "navigation/threadGitWorkingState/updated") {
        const params = event.notification
          .params as NavigationThreadGitWorkingStateUpdatedNotification["params"];
        setState((current) => ({
          ...current,
          rows: applyThreadGitWorkingStateUpdate(current.rows, params),
        }));
        return;
      }

      if (method === "navigation/threadDirectories/updated") {
        scheduleRefresh();
        return;
      }

      if (method === "thread/pullRequests/updated") {
        const { threadId, prs } = event.notification.params as {
          threadId: string;
          prs: PrSummary[];
        };
        setState((current) => {
          const nextResponse = applyThreadPullRequestsUpdate(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            threadId,
            prs,
          });
          prChipLocationIndexRef.current = nextResponse
            ? buildPrChipLocationIndex(nextResponse)
            : undefined;
          if (nextResponse === current.rows) {
            return current;
          }
          return {
            ...current,
            rows: nextResponse,
          };
        });
        scheduleRefresh();
        return;
      }

      if (method === "thread/reactions/updated") {
        const { threadId, reactions } = event.notification.params as {
          threadId: string;
          reactions: string[];
        };
        setState((current) => ({
          ...current,
          rows: updateThreadReactionsInLoadedRows(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            threadId,
            reactions,
          }),
        }));
        return;
      }

      if (method === "pullRequest/status/updated") {
        const { prKey, pr } = event.notification.params as {
          prKey: string;
          pr: PrSummary;
        };
        setState((current) => {
          const result = applyPullRequestStatusUpdate(current.rows, {
            prKey,
            pr,
            index: prChipLocationIndexRef.current,
          });
          prChipLocationIndexRef.current = result.index;
          if (result.snapshot === current.rows) {
            return current;
          }
          return {
            ...current,
            rows: result.snapshot,
          };
        });
        scheduleRefresh();
        return;
      }

      if (method === "thread/status/changed") {
        const { threadId, status } = event.notification.params as {
          threadId: string;
          status?: { type?: string };
        };
        const threadStatus = status?.type;
        if (
          threadStatus !== "active"
          && threadStatus !== "idle"
          && threadStatus !== "notLoaded"
          && threadStatus !== "unknown"
        ) {
          return;
        }


        setState((current) => ({
          ...current,
          rows: applyThreadStatusUpdate(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            threadId,
            threadStatus,
          }),
        }));
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId
            ? { ...current, threadStatus }
            : current
        );
        return;
      }

      if (method === "thread/name/updated") {
        const { threadId, threadName, titleSource } = event.notification
          .params as {
          threadId: string;
          threadName?: string;
          titleSource?: unknown;
        };
        const nextThreadName = threadName?.trim();
        if (!nextThreadName) {
          return;
        }
        // An emitter that knows the provenance says so; silence means an
        // operator rename, which is what this assumed for every rename before
        // the notification carried the field. Asserting `explicit` here is
        // what made a generated title suppress the placeholder-title paths in
        // `mergeHydratedThreadWithOptimisticTitle`.
        //
        // Normalized rather than trusted: federation forwards a peer's params
        // verbatim, so this is the one recorder reading another instance's
        // JSON. A value outside the union would match no snapshot row, and the
        // observation below retires by comparison — it would never retire, and
        // would re-pin this title on every refresh for the life of the hook.
        const nextTitleSource = normalizeRenamedTitleSource(titleSource);
        threadNameObservationsRef.current.set(
          agentEventThreadIdentityKey(event, threadId),
          { threadName: nextThreadName, titleSource: nextTitleSource },
        );
        setState((current) => ({
          ...current,
          rows: applyThreadNameUpdate(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            threadId,
            threadName: nextThreadName,
            titleSource: nextTitleSource,
          }),
        }));
        setOptimisticThread((current) => {
          if (!current || !agentEventMatchesThread(event, current, threadId)) {
            return current;
          }

          return {
            ...current,
            title: nextThreadName,
            titleSource: nextTitleSource,
          };
        });
        return;
      }

      if (method === "thread/rewound") {
        const { threadId, updatedAt } = event.notification.params as {
          threadId: string;
          updatedAt: number;
        };
        setState((current) => ({
          ...current,
          rows: applyThreadRewindUpdate(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            threadId,
            updatedAt,
          }),
        }));
        setOptimisticThread((current) =>
          current && agentEventMatchesThread(event, current, threadId)
            ? {
                ...current,
                threadStatus: "idle",
                updatedAt: Math.max(current.updatedAt ?? 0, updatedAt),
              }
            : current
        );
        scheduleRefresh();
        return;
      }

      if (method === "thread/archived") {
        const { threadId } = event.notification.params as {
          threadId: string;
        };
        const threadKey = agentEventThreadIdentityKey(event, threadId);
        suppressedArchivedThreadKeysRef.current.add(threadKey);

        setState((current) => ({
          ...current,
          rows: removeThreadFromLoadedRows(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            threadId,
          }),
        }));
        setSelectedItemKey((current) =>
          current === threadKey
            ? getFallbackSelectionAfterRemoval(state.rows, {
                backend: event.backend,
                federationTarget: event.federationTarget,
                threadId,
                optimisticThreadKey: optimisticThreadRef.current
                  ? threadSummaryIdentityKey(optimisticThreadRef.current)
                  : undefined,
              })
            : current
        );
        setRetainedUnreadThread((current) =>
          current && agentEventMatchesThread(event, current, threadId)
            ? undefined
            : current
        );
        setOptimisticThread((current) =>
          current && agentEventMatchesThread(event, current, threadId)
            ? undefined
            : current
        );
        return;
      }

      if (method === "thread/executionMode/updated") {
        const { threadId, executionMode } = event.notification.params as {
          threadId: string;
          executionMode: "default" | "full-access";
        };
        setState((current) => ({
          ...current,
          rows: applyThreadExecutionModeUpdate(current.rows, {
            backend: event.backend,
            threadId,
            executionMode,
          }),
        }));
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId
            ? { ...current, executionMode }
            : current
        );
        // Refresh so the persisted permissionTransitionLog (which the
        // registry just appended an `applied` entry to) flows back into
        // the snapshot for transcript rendering.
        scheduleRefresh();
        return;
      }

      if (method === "thread/executionMode/queued") {
        const { threadId, queuedExecutionMode, queuedAt } = event.notification
          .params as {
          threadId: string;
          queuedExecutionMode: "default" | "full-access";
          queuedAt: number;
        };
        setState((current) => ({
          ...current,
          rows: applyThreadExecutionModeQueued(current.rows, {
            backend: event.backend,
            threadId,
            queuedExecutionMode,
            queuedAt,
          }),
        }));
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId
            ? {
                ...current,
                queuedExecutionMode,
                queuedExecutionModeAt: queuedAt,
              }
            : current
        );
        // The registry already persisted a `queued` audit entry; pull
        // the snapshot so the transcript renders it.
        scheduleRefresh();
        return;
      }

      if (method === "thread/executionMode/queueCleared") {
        const { threadId } = event.notification.params as {
          threadId: string;
          reason: "applied" | "cancelled";
        };
        setState((current) => ({
          ...current,
          rows: applyThreadExecutionModeQueueCleared(current.rows, {
            backend: event.backend,
            threadId,
          }),
        }));
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId
            ? {
                ...current,
                queuedExecutionMode: undefined,
                queuedExecutionModeAt: undefined,
              }
            : current
        );
        // Pull the snapshot so the matching `applied` / `cancelled`
        // transition entry shows up in the transcript.
        scheduleRefresh();
        return;
      }

      if (method === "thread/codexEnvironment/updated") {
        const { threadId, codexEnvironmentRuntime } = event.notification
          .params as {
          threadId: string;
          codexEnvironmentRuntime?: NavigationThreadSummary["codexEnvironmentRuntime"];
        };
        setState((current) => ({
          ...current,
          rows: applyThreadCodexEnvironmentUpdate(current.rows, {
            backend: event.backend,
            threadId,
            codexEnvironmentRuntime,
          }),
        }));
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId
            ? { ...current, codexEnvironmentRuntime }
            : current
        );
        return;
      }

      if (method === "thread/modelSettings/updated") {
        const params = event.notification.params as {
          threadId: string;
          model?: string;
          reasoningEffort?: string;
          serviceTier?: string;
          fastMode?: boolean;
        };
        const modelSettingsPatch = {
          ...("model" in params ? { model: params.model } : {}),
          ...("reasoningEffort" in params
            ? { reasoningEffort: params.reasoningEffort }
            : {}),
          ...("serviceTier" in params
            ? { serviceTier: params.serviceTier }
            : {}),
          ...("fastMode" in params ? { fastMode: params.fastMode } : {}),
        };
        setState((current) => ({
          ...current,
          rows: applyThreadModelSettingsUpdate(current.rows, {
            backend: event.backend,
            threadId: params.threadId,
            ...modelSettingsPatch,
          }),
        }));
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === params.threadId
            ? { ...current, ...modelSettingsPatch }
            : current
        );
        return;
      }

      if (method === "thread/prAutoDispatch/updated") {
        const params = event.notification.params as {
          threadId: string;
          enabled: boolean;
        };
        setState((current) => ({
          ...current,
          rows: applyThreadPrAutoDispatchUpdate(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            ...params,
          }),
        }));
        setOptimisticThread((current) =>
          current && agentEventMatchesThread(event, current, params.threadId)
            ? { ...current, prAutoDispatchEnabled: params.enabled }
            : current
        );
        return;
      }

      if (method === "thread/prAutoDispatch/pendingUpdated") {
        const params = event.notification.params as {
          threadId: string;
          pending: NavigationThreadSummary["prAutoDispatchPending"] | null;
        };
        const pending = params.pending ?? undefined;
        setState((current) => ({
          ...current,
          rows: applyThreadPrAutoDispatchPendingUpdate(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            threadId: params.threadId,
            pending,
          }),
        }));
        setOptimisticThread((current) =>
          current && agentEventMatchesThread(event, current, params.threadId)
            ? { ...current, prAutoDispatchPending: pending }
            : current
        );
        return;
      }

      if (method === "thread/acpRuntime/updated") {
        const { threadId, acpRuntime } = event.notification.params as {
          threadId: string;
          acpRuntime?: NavigationThreadSummary["acpRuntime"];
        };
        setState((current) => ({
          ...current,
          rows: applyThreadAcpRuntimeUpdate(current.rows, {
            backend: event.backend,
            threadId,
            acpRuntime,
          }),
        }));
        setOptimisticThread((current) =>
          current?.source === event.backend && current.id === threadId
            ? {
                ...current,
                acpRuntime: {
                  ...current.acpRuntime,
                  ...acpRuntime,
                  configValues: {
                    ...(current.acpRuntime?.configValues ?? {}),
                    ...(acpRuntime?.configValues ?? {}),
                  },
                },
              }
            : current
        );
        scheduleRefresh();
        return;
      }

      if (method === "turn/failed") {
        // The backend registry appended a durable turn-failure entry to the
        // thread overlay before broadcasting this event. Refresh so the
        // navigation snapshot carries `turnFailureLog` into the transcript;
        // without it the failure would never surface as a durable entry.
        scheduleRefresh();
        return;
      }

      if (method === "thread/questionnaireActivity/updated") {
        // Completed questionnaire answers are persisted in the thread overlay
        // because App Server replay does not include request-user-input items.
        // Refresh so the sanitized Q/A summary appears in the transcript now.
        scheduleRefresh();
        return;
      }

      if (method === "thread/codexInvalidIdRecovery/updated") {
        // Recovery audit metadata is persisted on the failed turn before each
        // status event. Refresh so repair and automatic-resubmission markers
        // appear inline and survive transcript reconciliation.
        scheduleRefresh();
        return;
      }

      if (method === "thread/subAgents/updated") {
        const params = event.notification.params as {
          subAgents?: ThreadSubAgentSummary[];
          threadId: string;
        };
        if (!params.subAgents) {
          scheduleRefresh();
          return;
        }
        setState((current) => ({
          ...current,
          rows: updateThreadSubAgentsInLoadedRows(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            subAgents: params.subAgents ?? [],
            threadId: params.threadId,
          }),
        }));
        setOptimisticThread((current) =>
          current && agentEventMatchesThread(event, current, params.threadId)
            ? { ...current, subAgents: params.subAgents }
            : current
        );
        return;
      }

      if (
        method === "thread/automations/updated" ||
        method === "automation/run/updated" ||
        method === "thread/turnQueue/updated" ||
        method === "thread/agent/updated"
      ) {
        scheduleRefresh();
        return;
      }

      if (method === "thread/pin/added") {
        const { threadId, pinnedRank } = event.notification.params as {
          threadId: string;
          pinnedRank: string;
        };
        setState((current) => ({
          ...current,
          rows: updateThreadPinInLoadedRows(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            threadId,
            pinnedRank,
          }),
        }));
        return;
      }

      if (method === "thread/pin/removed") {
        const { threadId } = event.notification.params as {
          threadId: string;
        };
        setState((current) => ({
          ...current,
          rows: updateThreadPinInLoadedRows(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            threadId,
            pinnedRank: undefined,
          }),
        }));
        return;
      }

      if (method === "thread/pin/reordered") {
        const { pinnedRanks } = event.notification.params as {
          pinnedRanks: Record<string, string>;
        };
        setState((current) => ({
          ...current,
          rows: updateThreadPinsInLoadedRows(current.rows, {
            pinnedRanksByThreadKey: pinnedRanks,
          }),
        }));
        return;
      }

      if (method === "thread/parent/set") {
        const {
          threadId,
          parentThreadId,
          parentThreadBackend,
          parentThreadInstanceId,
        } = event.notification.params as {
          threadId: string;
          parentThreadId: string;
          parentThreadBackend?: AppServerBackendKind;
          parentThreadInstanceId?: string;
        };
        setState((current) => ({
          ...current,
          rows: updateThreadParentInLoadedRows(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            threadId,
            parentThreadId,
            parentThreadBackend,
            parentThreadInstanceId,
          }),
        }));
        scheduleRefresh();
        return;
      }

      if (method === "thread/parent/cleared") {
        const { threadId } = event.notification.params as {
          threadId: string;
        };
        setState((current) => ({
          ...current,
          rows: updateThreadParentInLoadedRows(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            threadId,
            parentThreadId: undefined,
            parentThreadBackend: undefined,
          }),
        }));
        scheduleRefresh();
        return;
      }

      if (method === "thread/subthreadOrder/updated") {
        const { parentThreadId, threadIds } = event.notification.params as {
          parentThreadId: string;
          threadIds: string[];
        };
        setState((current) => ({
          ...current,
          rows: updateSubthreadOrderInLoadedRows(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            parentThreadId,
            threadIds,
          }),
        }));
        return;
      }

      if (method === "thread/subthreadsCollapsed/updated") {
        const { parentThreadId, collapsed } = event.notification.params as {
          parentThreadId: string;
          collapsed: boolean;
        };
        setState((current) => ({
          ...current,
          rows: updateSubthreadsCollapsedInLoadedRows(current.rows, {
            backend: event.backend,
            federationTarget: event.federationTarget,
            parentThreadId,
            collapsed,
          }),
        }));
        return;
      }

      // Directory pin bus events (plan 2026-05-09-002, Unit I).
      // Patcher short-circuits when the rank already matches so the
      // IPC response → patch → bus event → patch chain collapses
      // into a single React render.
      if (method === "directory/pin/added") {
        const { directoryKey, pinnedRank } = event.notification.params as {
          directoryKey: string;
          pinnedRank: string;
        };
        setState((current) => ({
          ...current,
          rows: updateDirectoryPinInLoadedRows(current.rows, {
            directoryKey,
            pinnedRank,
          }),
        }));
        return;
      }

      if (method === "directory/pin/removed") {
        const { directoryKey } = event.notification.params as {
          directoryKey: string;
        };
        setState((current) => ({
          ...current,
          rows: updateDirectoryPinInLoadedRows(current.rows, {
            directoryKey,
            pinnedRank: undefined,
          }),
        }));
        return;
      }

      if (method === "directory/pin/reordered") {
        const { pinnedRanks } = event.notification.params as {
          pinnedRanks: Record<string, string>;
        };
        setState((current) => ({
          ...current,
          rows: updateDirectoryPinsInLoadedRows(current.rows, {
            pinnedRanks,
          }),
        }));
        return;
      }

      if (method === "directory/threadsCollapsed/updated") {
        const { directoryKey, collapsed } = event.notification.params as {
          directoryKey: string;
          collapsed: boolean;
        };
        const viewerCollapsed = windowTarget
          && isRemoteFederationTarget(windowTarget)
          ? remoteDirectoryThreadsCollapsedOverridesRef.current.get(directoryKey)
          : undefined;
        setState((current) => ({
          ...current,
          rows: updateDirectoryThreadsCollapsedInLoadedRows(
            current.rows,
            {
              directoryKey,
              collapsed: viewerCollapsed ?? collapsed,
            },
          ),
        }));
        return;
      }

      if (method === "thread/unarchived") {
        const { threadId } = event.notification.params as {
          threadId: string;
        };
        suppressedArchivedThreadKeysRef.current.delete(
          agentEventThreadIdentityKey(event, threadId)
        );
        scheduleRefresh();
        return;
      }

      if (method === "thread/started") {
        scheduleRefresh();
        return;
      }

      if (
        method === "turn/completed" ||
        method === "turn/failed" ||
        method === "turn/cancelled"
      ) {
        scheduleRefresh();
      }
    });
  }, [desktopApi, enabled, markNavigationActivity, scheduleRefresh, state.rows]);

  // Binding chips are projected in row pages but can be mutated outside
  // the agent-event bus (a Telegram callback creates a binding, a
  // /sync name renames it, a /detach revokes it — none of those emit
  // backend notifications). Without this hook the binding chip stays
  // stale until the next backend tick. See issue #191.
  useEffect(() => {
    if (!enabled || !desktopApi?.onMessagingBindingsChanged) {
      return;
    }
    return desktopApi.onMessagingBindingsChanged(() => {
      markNavigationActivity({ refreshOnIdleResume: false });
      scheduleRefresh();
    });
  }, [desktopApi, enabled, markNavigationActivity, scheduleRefresh]);

  const threads = useMemo(() => {
    const retainedKey = browseMode !== "attention" && retainedUnreadThread ? threadSummaryIdentityKey(retainedUnreadThread) : undefined;
    const currentThreads = loadedThreadRows(state.rows).map((thread) => threadSummaryIdentityKey(thread) === retainedKey
      ? { ...thread, inbox: { ...thread.inbox, inInbox: true } } : thread);
    if (!optimisticThread) {
      return currentThreads;
    }

    const optimisticThreadKey = threadSummaryIdentityKey(optimisticThread);

    const hasHydratedThread = currentThreads.some(
      (thread) => threadSummaryIdentityKey(thread) === optimisticThreadKey
    );
    if (hasHydratedThread) {
      return currentThreads.map((thread) =>
        threadSummaryIdentityKey(thread) === optimisticThreadKey
          ? mergeHydratedThreadWithOptimisticState(thread, optimisticThread)
          : thread
      );
    }

    return [optimisticThread, ...currentThreads];
  }, [optimisticThread, state.rows, browseMode, retainedUnreadThread]);

  const directories = useMemo(
    () => {
      const launchpads = Object.values(localLaunchpads);
      const currentDirectories = launchpads.reduce(
        (nextDirectories, launchpad) =>
          upsertLaunchpadDirectory(nextDirectories, launchpad, {
            preserveExistingDirectoryAuthority: Boolean(rendererFederationTarget),
          }),
        loadedDirectoryRows(state.rows) ?? [],
      );

      if (!optimisticThread) {
        return currentDirectories;
      }

      const optimisticThreadKey = threadSummaryIdentityKey(optimisticThread);
      const hasHydratedThread = loadedThreadRows(state.rows).some(
        (thread) => threadSummaryIdentityKey(thread) === optimisticThreadKey
      );

      return projectOptimisticThreadIntoDirectories(
        currentDirectories,
        hasHydratedThread ? undefined : optimisticThread
      );
    },
    [
      localLaunchpads,
      optimisticThread,
      state.rows,
      rendererFederationTarget,
    ]
  );

  useEffect(() => {
    // Move the renderer-local fallback draft and its selection onto the
    // authoritative workspace key. Keeping the alias in localLaunchpads would
    // reintroduce it after every snapshot refresh.
    const canonicalWorkspace = loadedDirectoryRows(state.rows).find(
      (directory) =>
        directory.kind === "workspace"
        && directory.key !== ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY
        && Boolean(directory.path),
    );
    if (!canonicalWorkspace) {
      return;
    }

    setLocalLaunchpads((current) => {
      const fallbackLaunchpad = current[ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY];
      if (!fallbackLaunchpad) {
        return current;
      }

      const next = { ...current };
      delete next[ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY];
      const canonicalLaunchpad =
        current[canonicalWorkspace.key]
        ?? fallbackLaunchpad
        ?? canonicalWorkspace.launchpad;
      next[canonicalWorkspace.key] = {
        ...canonicalLaunchpad,
        directoryKey: canonicalWorkspace.key,
        directoryKind: "workspace",
        directoryLabel: canonicalWorkspace.label,
        directoryPath: canonicalWorkspace.path,
      };
      return next;
    });

    setSelectedItemKey((current) =>
      current === buildLaunchpadSelectionKey(ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY)
        ? buildLaunchpadSelectionKey(canonicalWorkspace.key)
        : current
    );
  }, [state.rows]);

  const inboxThreads = threads;
  const recentThreads = useMemo(
    () => [...threads].sort(compareThreadsByCreatedAtDesc),
    [threads],
  );

  const initialFallbackSelectionKey = useMemo(() => {
    if (
      selectedItemKey
      || initialSelectionEstablishedRef.current
      || !state.rows
    ) {
      return undefined;
    }

    return getFallbackSelectionKey(
      {
        ...state.rows,
        directoryRows: indexLoadedDirectoryRows(directories),
        threadRows: indexLoadedThreadRows(threads),
      },
      optimisticThread
        ? threadSummaryIdentityKey(optimisticThread)
        : undefined,
    );
  }, [directories, optimisticThread, selectedItemKey, state.rows, threads]);
  const displaySelectionKey = selectedItemKey ?? initialFallbackSelectionKey;
  useEffect(() => {
    if (selectedItemKey) {
      initialSelectionEstablishedRef.current = true;
      return;
    }
    if (!initialFallbackSelectionKey) {
      if (
        state.rows
        && state.startupSelectionSettled
        && boundedNavigation.resources.get(browseMode === "directories" ? "directory-index" : "lens")?.state.page?.coverage.state === "complete"
      ) {
        // An empty settled full startup is still a completed selection
        // decision. A progressive active-recent page is explicitly unsettled:
        // even if provider refresh has already reached "ready", its empty row
        // set cannot close the selection window before the queued full page.
        // Once the full page settles, do not let a later operator action that
        // adds a directory turn into implicit navigation to its launchpad.
        initialSelectionEstablishedRef.current = true;
      }
      return;
    }

    // The startup snapshot and its selection are separate React state writes.
    // Under a loaded renderer the selectable rows can commit first, leaving a
    // visible but unselected thread or launchpad until the selection update is
    // scheduled. Derive the first display selection from the published rows,
    // then commit it for subsequent user-driven navigation. Once a real
    // selection has existed, an intentional clear (for example Cancel on a
    // launchpad) remains clear instead of being auto-selected again.
    initialSelectionEstablishedRef.current = true;
    setSelectedItemKey(initialFallbackSelectionKey);
  }, [
    initialFallbackSelectionKey,
    selectedItemKey,
    state.rows,
    state.startupSelectionSettled,
  ]);

  const activeFederatedLaunchpad =
    federatedLaunchpad
    && displaySelectionKey === buildFederatedLaunchpadSelectionKey(
      federatedLaunchpad.target,
    )
      ? federatedLaunchpad
      : undefined;
  const launchpadDirectories = activeFederatedLaunchpad?.directories ?? directories;

  const selectedThreadKey = useMemo(() => {
    if (
      displaySelectionKey
      && !getDirectoryKeyFromLaunchpadSelection(displaySelectionKey)
      && !isFederatedLaunchpadSelectionKey(displaySelectionKey)
    ) {
      return displaySelectionKey;
    }

    return undefined;
  }, [displaySelectionKey]);

  const selectedRow = useMemo<NavigationThreadSummary | undefined>(
    () =>
      selectedThreadKey
        ? threads.find(
            (thread) => threadSummaryIdentityKey(thread) === selectedThreadKey
          )
        : undefined,
    [selectedThreadKey, threads]
  );

  const selectedThreadConfigurationReady = selectedDetail.state?.readiness === "ready"
    && selectedDetail.state.detail?.identity === "present";
  const selectedThread = useMemo(() => {
    const detailThread = selectedDetail.state?.detail?.thread;
    if (!detailThread) return selectedRow;
    const configured = optimisticThread && threadSummaryIdentityKey(detailThread) === threadSummaryIdentityKey(optimisticThread)
      ? mergeHydratedThreadWithOptimisticState(detailThread, optimisticThread) : detailThread;
    return rendererFederationTarget?.scope !== "remote" && configured.federation?.ref.target.scope === "remote"
      ? { ...configured, pinnedRank: selectedRow?.pinnedRank } : configured;
  }, [selectedDetail.state?.detail?.thread, selectedRow, optimisticThread, rendererFederationTarget]);

  const selectedDirectory = useMemo(() => {
    if (activeFederatedLaunchpad) {
      return activeFederatedLaunchpad.directory;
    }

    const launchpadDirectoryKey = getDirectoryKeyFromLaunchpadSelection(
      displaySelectionKey,
    );
    if (launchpadDirectoryKey) {
      return directories.find((directory) => directory.key === launchpadDirectoryKey);
    }

    if (!selectedThreadKey) {
      return undefined;
    }

    return directories.find((directory) =>
      directoryKeysForThread(selectedDetail.state?.detail?.thread).includes(directory.key)
    );
  }, [
    activeFederatedLaunchpad,
    directories,
    displaySelectionKey,
    selectedThreadKey,
    selectedDetail.state?.detail?.thread,
  ]);
  const selectedLaunchpad = useMemo(() => {
    if (activeFederatedLaunchpad) {
      return activeFederatedLaunchpad.launchpad;
    }

    const launchpadDirectoryKey = getDirectoryKeyFromLaunchpadSelection(
      displaySelectionKey,
    );
    if (!launchpadDirectoryKey) {
      return undefined;
    }

    return directories.find((directory) => directory.key === launchpadDirectoryKey)
      ?.launchpad;
  }, [activeFederatedLaunchpad, directories, displaySelectionKey]);

  // The directory label the New Thread button would resolve to with its
  // default (context-aware) behavior, or undefined when that resolves to the
  // directory-less workspace. Drives the "New chat in <directory>" item in the
  // New Thread flyout, and lets callers hide that item when there's no
  // directory to contrast against the "without a directory" choice.
  const newThreadDirectoryLabel = useMemo(() => {
    const target = resolveCreateThreadTargetDirectory({
      directories,
      selectedDirectory: activeFederatedLaunchpad ? undefined : selectedDirectory,
      selectedThread: selectedDetail.state?.detail?.thread,
    });
    return target.directoryKind === "directory" ? target.directoryLabel : undefined;
  }, [activeFederatedLaunchpad, directories, selectedDirectory, selectedThreadKey, selectedDetail.state?.detail?.thread]);
  // The thread card to render as the orange "composing" source while a
  // sub-thread launchpad is open. Plain new-thread launchpads have no source.
  const composerSourceThreadKey = useMemo(() => {
    if (!selectedLaunchpad?.sourceThreadId || !selectedLaunchpad.backend) {
      return undefined;
    }
    return buildThreadIdentityKey(
      selectedLaunchpad.backend,
      selectedLaunchpad.sourceThreadId,
    );
  }, [selectedLaunchpad]);

  useEffect(() => {
    releaseRetainedUnreadThread(selectedItemKey);
  }, [releaseRetainedUnreadThread, retainedUnreadThread, selectedItemKey]);

  useEffect(() => {
    const submitMarkThreadSeen = markThreadSeen;

    if (
      !pendingSeenThreadKey ||
      !selectedThread ||
      pendingSeenThreadKey !== threadSummaryIdentityKey(selectedThread) ||
      !submitMarkThreadSeen
    ) {
      return;
    }

    const markThreadSeenRequest = submitMarkThreadSeen;
    const threadToMarkSeen = selectedThread;

    async function markSeen(): Promise<void> {
      const threadKey = threadSummaryIdentityKey(threadToMarkSeen);
      submittedSeenUpdatedAtByThreadKeyRef.current.set(
        threadKey,
        threadToMarkSeen.updatedAt
      );

      try {
        await markThreadSeenRequest({
          backend: threadToMarkSeen.source,
          ...(threadToMarkSeen.federation?.ref.target
            ? { federationTarget: threadToMarkSeen.federation.ref.target }
            : {}),
          threadId: threadToMarkSeen.id,
          seenUpdatedAt: threadToMarkSeen.updatedAt,
        });
        if (mountedRef.current) {
          const retainedThread = retainedUnreadThreadRef.current;
          if (
            !retainedThread ||
            threadSummaryIdentityKey(retainedThread) !== threadKey
          ) {
            setState((current) => ({
              ...current,
              rows: markThreadSeenInLoadedRows(current.rows, {
                backend: threadToMarkSeen.source,
                federationTarget: threadToMarkSeen.federation?.ref.target,
                threadId: threadToMarkSeen.id,
                seenUpdatedAt: threadToMarkSeen.updatedAt,
              }),
            }));
          }
        }
      } catch {
        // A selected remote thread can become unreachable between the
        // navigation snapshot and this write. Keep its unread state intact;
        // selecting it again will submit a fresh attempt.
      } finally {
        if (mountedRef.current) {
          setPendingSeenThreadKey((current) =>
            current === threadKey ? undefined : current
          );
        }
      }
    }

    void markSeen();
  }, [markThreadSeen, pendingSeenThreadKey, selectedThread]);

  const refreshThreadDirectoryGitStatuses = useCallback(
    (threadKey: string): void => {
      if (!desktopApi?.refreshDirectoryGitStatuses) {
        return;
      }

      const directoryKeys = directoryKeysForThread(selectedDetail.state?.detail?.thread
        && threadSummaryIdentityKey(selectedDetail.state.detail.thread) === threadKey
        ? selectedDetail.state.detail.thread : undefined);
      if (directoryKeys.length === 0) {
        return;
      }

      void desktopApi.refreshDirectoryGitStatuses({
        directoryKeys,
        federationTarget: rendererFederationTarget,
        force: true,
      });
    },
    [
      desktopApi,
      selectedDetail.state?.detail?.thread,
      directories,
      rendererFederationTarget,
    ]
  );

  useEffect(() => {
    if (
      !selectedThread ||
      selectedThread.inbox.reason !== "updated-since-seen" ||
      !viewForeground ||
      !threadViewVisible ||
      // The Attention lens is a work queue: opening something to look at it
      // must not silently empty the queue. Only a reply clears unread there
      // (see `markThreadsSeen`, called from the composer on a sent turn).
      browseMode === "attention"
    ) {
      return;
    }

    const threadKey = threadSummaryIdentityKey(selectedThread);
    if (!manuallySelectedThreadKeysRef.current.has(threadKey)) {
      return;
    }
    const retainedThreadKey = retainedUnreadThread
      ? threadSummaryIdentityKey(retainedUnreadThread)
      : undefined;

    if (
      retainedThreadKey === threadKey &&
      retainedUnreadThread?.updatedAt !== selectedThread.updatedAt
    ) {
      setRetainedUnreadThread(selectedThread);
    }

    if (
      pendingSeenThreadKey === threadKey ||
      selectedThread.inbox.lastSeenUpdatedAt === selectedThread.updatedAt ||
      submittedSeenUpdatedAtByThreadKeyRef.current.get(threadKey) ===
        selectedThread.updatedAt
    ) {
      return;
    }

    setPendingSeenThreadKey(threadKey);
  }, [
    browseMode,
    pendingSeenThreadKey,
    retainedUnreadThread,
    selectedThread,
    threadViewVisible,
    viewForeground,
  ]);

  const selectThread = useCallback((thread: NavigationThreadSummary): void => {
    const threadKey = threadSummaryIdentityKey(thread);
    manuallySelectedThreadKeysRef.current.add(threadKey);
    releaseRetainedUnreadThread(threadKey);
    refreshThreadDirectoryGitStatuses(threadKey);
    setCreateThreadError(undefined);
    setLaunchpadError(undefined);
    setArchiveThreadError(undefined);
    setSetThreadExecutionModeError(undefined);
    setSetThreadModelSettingsError(undefined);
    setSelectedItemKey(threadKey);
    // Focusing a thread from the Attention work queue must not empty the
    // queue — only a reply does. Every other lens marks seen on focus.
    //
    // `retainedUnreadThread` is skipped along with it, and deliberately: it
    // holds the cookie visible on a thread that HAS been marked seen and then
    // clears it on the way out (`releaseRetainedUnreadThread`). With nothing
    // marked seen here, retaining would do no work on arrival and would clear
    // the thread on departure — the exact behavior this lens exists to avoid.
    //
    // Scoped to these two statements rather than an early return, so that
    // anything added to the end of this function later still runs in every
    // lens.
    if (browseMode !== "attention") {
      setPendingSeenThreadKey(threadKey);
      if (thread.inbox.inInbox && thread.inbox.reason === "updated-since-seen") {
        setRetainedUnreadThread(thread);
      }
    }
  }, [browseMode, refreshThreadDirectoryGitStatuses, releaseRetainedUnreadThread]);

  const markThreadsSeen = useCallback(
    async (candidateThreads: NavigationThreadSummary[]): Promise<void> => {
      if (!markThreadSeen) {
        return;
      }

      const unreadThreadsByKey = new Map<string, NavigationThreadSummary>();
      for (const thread of candidateThreads) {
        if (!thread.inbox.inInbox) {
          continue;
        }
        unreadThreadsByKey.set(
          threadSummaryIdentityKey(thread),
          thread,
        );
      }
      const unreadThreads = [...unreadThreadsByKey.values()];
      if (unreadThreads.length === 0) {
        return;
      }

      for (const thread of unreadThreads) {
        submittedSeenUpdatedAtByThreadKeyRef.current.set(
          threadSummaryIdentityKey(thread),
          thread.updatedAt,
        );
      }

      const results = await Promise.allSettled(
        unreadThreads.map(async (thread) => {
          await markThreadSeen({
            backend: thread.source,
            ...(thread.federation?.ref.target
              ? { federationTarget: thread.federation.ref.target }
              : {}),
            threadId: thread.id,
            seenUpdatedAt: thread.updatedAt,
          });
          return thread;
        }),
      );
      const markedThreads = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (!mountedRef.current || markedThreads.length === 0) {
        return;
      }

      const markedThreadKeys = new Set(
        markedThreads.map((thread) =>
          threadSummaryIdentityKey(thread),
        ),
      );
      const seenThreads = markedThreads.map((thread) => ({
        backend: thread.source,
        federationTarget: thread.federation?.ref.target,
        threadId: thread.id,
        seenUpdatedAt: thread.updatedAt,
      }));
      setState((current) => ({
        ...current,
        rows: markThreadsSeenInLoadedRows(current.rows, seenThreads),
      }));
      setRetainedUnreadThread((current) => {
        if (
          current
          && markedThreadKeys.has(
            threadSummaryIdentityKey(current),
          )
        ) {
          return undefined;
        }
        return current;
      });
      setPendingSeenThreadKey((current) =>
        current && markedThreadKeys.has(current) ? undefined : current,
      );
    },
    [markThreadSeen],
  );

  const markThreadUnread = useCallback(
    async (thread: NavigationThreadSummary): Promise<void> => {
      if (!markThreadSeen || thread.updatedAt === undefined) {
        return;
      }

      const threadKey = threadSummaryIdentityKey(thread);
      const seenUpdatedAt = Math.max(0, thread.updatedAt - 1);
      await markThreadSeen({
        backend: thread.source,
        ...(thread.federation?.ref.target
          ? { federationTarget: thread.federation.ref.target }
          : {}),
        threadId: thread.id,
        seenUpdatedAt,
      });
      if (!mountedRef.current) {
        return;
      }

      manuallySelectedThreadKeysRef.current.delete(threadKey);
      submittedSeenUpdatedAtByThreadKeyRef.current.delete(threadKey);
      setPendingSeenThreadKey((current) =>
        current === threadKey ? undefined : current,
      );
      setRetainedUnreadThread((current) =>
        current && threadSummaryIdentityKey(current) === threadKey
          ? undefined
          : current,
      );
      setState((current) => ({
        ...current,
        rows: markThreadUnreadInLoadedRows(current.rows, {
          backend: thread.source,
          federationTarget: thread.federation?.ref.target,
          threadId: thread.id,
          seenUpdatedAt,
        }),
      }));
    },
    [markThreadSeen],
  );

  const showThread = useCallback(
    async (params: {
      backend: AppServerBackendKind;
      federationTarget?: FederationTarget;
      threadId: string;
    }): Promise<void> => {
      const threadKey = params.federationTarget
        && isRemoteFederationTarget(params.federationTarget)
        ? federatedThreadIdentityKey({
            backend: params.backend,
            target: params.federationTarget,
            threadId: params.threadId,
          })
        : buildThreadIdentityKey(params.backend, params.threadId);
      const thread = loadedThreadRows(state.rows).find(
        (candidate) =>
          candidate.source === params.backend
          && candidate.id === params.threadId
          && federationTargetsEqual(
            candidate.federation?.ref.target,
            params.federationTarget,
          ),
      );
      if (thread) {
        selectThread(thread);
        return;
      }
      setSelectedItemKey(threadKey);
      await refresh(threadKey, undefined, true);
    },
    [refresh, selectThread, state.rows],
  );

  const selectDirectoryLaunchpad = useCallback((directoryKey: string): void => {
    setCreateThreadError(undefined);
    setLaunchpadError(undefined);
    setArchiveThreadError(undefined);
    setSetThreadExecutionModeError(undefined);
    setSetThreadModelSettingsError(undefined);
    setSelectedItemKey(buildLaunchpadSelectionKey(directoryKey));
  }, []);

  const selectPendingLaunchpad = useCallback((selectionKey: string): void => {
    const creation = pendingLaunchpadCreationsRef.current.get(selectionKey);
    if (!creation) return;
    if (creation.federatedSession) setFederatedLaunchpad(creation.federatedSession);
    setSelectedItemKey(creation.selectionKey);
  }, []);

  const createThread = useCallback(
    async (
      backend?: AppServerBackendKind,
      executionMode: ThreadExecutionMode = "default",
      options?: { forceWorkspace?: boolean }
    ): Promise<void> => {
      if (!desktopApi?.ensureDirectoryLaunchpad) {
        setCreateThreadError("Desktop bridge is missing ensureDirectoryLaunchpad().");
        return;
      }

      setCreatingThread({ backend: backend ?? "codex", executionMode });
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);
      setArchiveThreadError(undefined);
      setSetThreadModelSettingsError(undefined);

      try {
        if (!options?.forceWorkspace && selectedThreadKey && !selectedDetail.state?.detail?.thread) {
          throw new Error("Wait for the selected thread's owner configuration before creating a thread here.");
        }
        const targetDirectory = resolveCreateThreadTargetDirectory({
          directories,
          selectedDirectory: activeFederatedLaunchpad
            ? undefined
            : selectedDirectory,
          selectedThread: selectedDetail.state?.detail?.thread,
          forceWorkspace: options?.forceWorkspace,
        });
        const directoryKey = targetDirectory.directoryKey;
        const response = await desktopApi.ensureDirectoryLaunchpad({
          federationTarget: rendererFederationTarget,
          directoryKey,
          directoryKind: targetDirectory.directoryKind,
          directoryLabel: targetDirectory.directoryLabel,
          directoryPath: targetDirectory.directoryPath,
          ...(targetDirectory.gitStatus
            ? { gitStatus: targetDirectory.gitStatus }
            : {}),
          currentBranch: targetDirectory.gitStatus?.currentBranch,
          preferredBackend: backend,
        });
        let launchpad = response.launchpad;
        let defaults: NavigationLaunchpadDefaults = response.defaults;
        if (
          executionMode !== response.launchpad.executionMode &&
          desktopApi.updateDirectoryLaunchpad
        ) {
          const updated = await desktopApi.updateDirectoryLaunchpad({
            directoryKey,
            patch: { executionMode },
          });
          launchpad = updated.launchpad;
          defaults = updated.defaults;
        }
        setLocalLaunchpads((current) => ({
          ...current,
          [directoryKey]: launchpad,
        }));
        const pendingGitStatus = takePendingDirectoryGitStatus(directoryKey);
        const ensuredGitStatus =
          response.gitStatus !== undefined
            ? response.gitStatus
            : pendingGitStatus;
        setState((current) => ({
          ...current,
          rows: applyLaunchpadUpdate(
            current.rows,
            launchpad,
            defaults,
            {
              preserveExistingDirectoryAuthority: Boolean(
                rendererFederationTarget,
              ),
              ...(ensuredGitStatus !== undefined
                ? { gitStatus: ensuredGitStatus }
                : {}),
            },
          ),
        }));
        const selectionKey = buildLaunchpadSelectionKey(directoryKey);
        pendingPickedLaunchpadRef.current.set(directoryKey, launchpad);
        setSelectedItemKey(selectionKey);
        await refresh(selectionKey, undefined, true);
        const pendingLaunchpad =
          pendingPickedLaunchpadRef.current.get(directoryKey) ?? launchpad;
        setState((current) => ({
          ...current,
          rows: applyLaunchpadUpdateIfMissing(
            current.rows,
            pendingLaunchpad,
            defaults,
            {
              preserveExistingDirectoryAuthority: Boolean(
                rendererFederationTarget,
              ),
            },
          ),
        }));
        setSelectedItemKey(selectionKey);
      } catch (error) {
        setCreateThreadError(error instanceof Error ? error.message : String(error));
      } finally {
        const targetDirectory = resolveCreateThreadTargetDirectory({
          directories,
          selectedDirectory: activeFederatedLaunchpad
            ? undefined
            : selectedDirectory,
          selectedThread: selectedDetail.state?.detail?.thread,
          forceWorkspace: options?.forceWorkspace,
        });
        pendingPickedLaunchpadRef.current.delete(targetDirectory.directoryKey);
        setCreatingThread(undefined);
      }
    },
    [
      desktopApi,
      directories,
      refresh,
      activeFederatedLaunchpad,
      selectedDirectory,
      selectedThreadKey,
      selectedDetail.state?.detail?.thread,
      takePendingDirectoryGitStatus,
      rendererFederationTarget,
    ]
  );

  /**
   * The "group root" for a source card. Sub-threads and forks never nest deeper
   * than one level: spawning from a child re-parents the new thread to that
   * child's root so it renders as a sibling, not an (unrenderable) grandchild.
   * Falls back to the source itself when its root is gone (archived/unlinked),
   * since the source has then become effectively top-level.
   */
  const resolveGroupRoot = useCallback(
    (source: NavigationThreadSummary) => resolveNavigationActionGroupRoot({ api: desktopApi, thread: source,
      target: readRendererFederationTarget(), signal: actionAbortControllerRef.current.signal }),
    [desktopApi],
  );

  /**
   * Place a freshly created child directly below the card it was spawned from.
   * The owner inserts into its complete current order, preserving unloaded
   * siblings, then expands the group so the new child is visible.
   */
  const insertSubthreadBelowSource = useCallback(
    async (
      parentBackend: AppServerBackendKind,
      rootThreadId: string,
      sourceThreadId: string,
      newThreadId: string,
      federationTarget?: FederationTarget,
    ): Promise<void> => {
      let root: NavigationThreadSummary;
      try {
        root = await readNavigationActionThread({ api: desktopApi,
          thread: { source: parentBackend, id: rootThreadId }, target: federationTarget,
          signal: actionAbortControllerRef.current.signal });
      } catch (error) {
        // Creation has already succeeded. Preserve its selection even if the
        // owner's group configuration is no longer available for insertion.
        console.warn("Could not load the group order for the created child:", error);
        return;
      }
      const rootKey = threadSummaryIdentityKey(root);
      if (federationTarget && !threadSupportsFederationCapability(root, "thread_grouping")) return;
      // Await the persist so callers can sequence the authoritative refresh
      // after it commits — otherwise a refresh racing ahead of this write can
      // momentarily resurrect the pre-insert order.
      const persistOrder = desktopApi?.updateSubthreadOrder;
      if (persistOrder) {
        try {
          const result = await persistOrder({
            backend: parentBackend,
            federationTarget,
            parentThreadId: rootThreadId,
            insertAfter: { threadId: newThreadId, sourceThreadId },
          });
          setState((current) => ({
            ...current,
            rows: updateSubthreadOrderInLoadedRows(current.rows, {
              backend: result.backend,
              federationTarget,
              parentThreadId: result.parentThreadId,
              threadIds: result.threadIds,
            }),
          }));
        } catch {
          await refresh(rootKey);
        }
      }

      if (root?.subthreadsCollapsed) {
        setState((current) => ({
          ...current,
          rows: updateSubthreadsCollapsedInLoadedRows(current.rows, {
            backend: parentBackend,
            federationTarget,
            parentThreadId: rootThreadId,
            collapsed: false,
          }),
        }));
        void desktopApi?.setSubthreadsCollapsed?.({
          backend: parentBackend,
          federationTarget,
          parentThreadId: rootThreadId,
          collapsed: false,
        }).catch(() => {});
      }
    },
    [desktopApi, refresh],
  );

  const createSubthread = useCallback(
    async (
      parent: NavigationThreadSummary,
      mode: ThreadWorkspaceMode = "same-worktree",
    ): Promise<void> => {
      if (!desktopApi?.ensureDirectoryLaunchpad) {
        setCreateThreadError("Desktop bridge is missing ensureDirectoryLaunchpad().");
        return;
      }

      let workspaceDirectories: Awaited<ReturnType<typeof readNavigationActionDetail>>["workspaceDirectories"];
      let groupRoot: NavigationThreadSummary;
      try {
        const detail = await readNavigationActionDetail({ api: desktopApi, thread: parent, target: readRendererFederationTarget(),
          signal: actionAbortControllerRef.current.signal, includeWorkspaceConfiguration: true });
        parent = detail.thread;
        workspaceDirectories = detail.workspaceDirectories;
        groupRoot = await resolveGroupRoot(parent);
      } catch (error) {
        setCreateThreadError(error instanceof Error ? error.message : String(error));
        return;
      }

      const directory = selectThreadWorkspace(parent, mode);
      const launchpadDirectoryPath =
        mode === "new-worktree"
          ? directory.gitStatusSourcePath ?? directory.directoryPath
          : directory.directoryPath;
      // Key the launchpad on the clicked card so each source gets its own
      // composer (two children of one root must not collide), but link the new
      // thread to the group root and remember the source for in-place insertion.
      const directoryKey = buildSubthreadLaunchpadKey(parent, mode);

      const federationTarget =
        parent.federation?.ref.target ?? rendererFederationTarget;
      const groupRootInstanceId = groupRoot.federation?.ref.target
        && isRemoteFederationTarget(groupRoot.federation.ref.target)
        ? groupRoot.federation.ref.target.instanceId
        : parent.parentThreadInstanceId;
      const childOwnerInstanceId = federationTarget
        && isRemoteFederationTarget(federationTarget)
        ? federationTarget.instanceId
        : undefined;
      const parentThreadInstanceId =
        groupRootInstanceId
        && groupRootInstanceId !== childOwnerInstanceId
          ? groupRootInstanceId
          : undefined;
      setCreatingThread({
        backend: parent.source,
        executionMode: parent.executionMode ?? "default",
      });
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);
      setArchiveThreadError(undefined);
      setSetThreadModelSettingsError(undefined);

      try {
        const response = await desktopApi.ensureDirectoryLaunchpad({
          federationTarget,
          directoryKey,
          directoryKind: directory.directoryKind,
          directoryLabel: directory.directoryLabel,
          directoryPath: launchpadDirectoryPath,
          gitStatusSourcePath: directory.gitStatusSourcePath,
          ...(parent.federation
            ? {
                gitStatus: loadedDirectoryRows(stateRef.current.rows).find(
                  (entry) =>
                    entry.path === directory.gitStatusSourcePath
                    || entry.path === directory.directoryPath,
                )?.gitStatus,
              }
            : {}),
          currentBranch: directory.branchName,
          parentThreadId: groupRoot.id,
          parentThreadBackend: groupRoot.source,
          ...(parentThreadInstanceId ? { parentThreadInstanceId } : {}),
          parentThreadTitle: groupRoot.title,
          preferredBackend: parent.source,
        });
        let launchpad: NavigationLaunchpadDraft = {
          ...response.launchpad,
          federationTarget,
          parentThreadId: groupRoot.id,
          parentThreadBackend: groupRoot.source,
          parentThreadInstanceId,
          parentThreadTitle: groupRoot.title,
          sourceThreadId: parent.id,
        };
        let defaults: NavigationLaunchpadDefaults = response.defaults;
        const patch: Parameters<NonNullable<DesktopApi["updateDirectoryLaunchpad"]>>[0]["patch"] = {
          backend: parent.source,
          executionMode: parent.executionMode ?? response.launchpad.executionMode,
          workMode: directory.workMode,
          directoryLabel: directory.directoryLabel,
          directoryPath: launchpadDirectoryPath,
          federationTarget,
          ...(directory.branchName ? { branchName: directory.branchName } : {}),
          parentThreadId: groupRoot.id,
          parentThreadBackend: groupRoot.source,
          parentThreadInstanceId,
          parentThreadTitle: groupRoot.title,
        };
        if (desktopApi.updateDirectoryLaunchpad) {
          const updated = await desktopApi.updateDirectoryLaunchpad({
            directoryKey,
            patch,
          });
          const optimisticLaunchpad = {
            ...applyNavigationLaunchpadProviderSettingsPatch<NavigationLaunchpadDraft>(
              launchpad,
              patch,
            ),
            parentThreadId: groupRoot.id,
            parentThreadBackend: groupRoot.source,
            parentThreadInstanceId,
            parentThreadTitle: groupRoot.title,
            sourceThreadId: parent.id,
          };
          launchpad = {
            ...mergeLaunchpadUpdateResponse(
              optimisticLaunchpad,
              updated.launchpad,
              patch,
              {
                preserveOwnerCodexEnvironmentMetadata: Boolean(
                  parent.federation || rendererFederationTarget,
                ),
              },
            ),
            parentThreadId: groupRoot.id,
            parentThreadBackend: groupRoot.source,
            parentThreadInstanceId,
            parentThreadTitle: groupRoot.title,
            sourceThreadId: parent.id,
          };
          defaults = updated.defaults;
        }
        setLocalLaunchpads((current) => ({
          ...current,
          [directoryKey]: launchpad,
        }));
        const pendingGitStatus = takePendingDirectoryGitStatus(directoryKey);
        const ensuredGitStatus =
          response.gitStatus !== undefined
            ? response.gitStatus
            : pendingGitStatus ?? workspaceDirectories?.find((candidate) =>
              candidate.path === directory.gitStatusSourcePath || candidate.path === launchpadDirectoryPath)?.gitStatus;
        setState((current) => ({
          ...current,
          rows: applyLaunchpadUpdate(current.rows, launchpad, defaults, {
            ...(ensuredGitStatus !== undefined
              ? { gitStatus: ensuredGitStatus }
              : {}),
            gitStatusSourcePath: directory.gitStatusSourcePath,
          }),
        }));
        setSelectedItemKey(buildLaunchpadSelectionKey(directoryKey));
      } catch (error) {
        setCreateThreadError(error instanceof Error ? error.message : String(error));
      } finally {
        setCreatingThread(undefined);
      }
    },
    [
      desktopApi,
      rendererFederationTarget,
      resolveGroupRoot,
      takePendingDirectoryGitStatus,
    ],
  );

  const forkThread = useCallback(
    async (
      parent: NavigationThreadSummary,
      mode: ThreadWorkspaceMode,
    ): Promise<void> => {
      if (!forkThreadRequest) {
        setCreateThreadError("Desktop bridge is missing forkThread().");
        return;
      }

      let groupRoot: NavigationThreadSummary;
      try {
        parent = await readNavigationActionThread({ api: desktopApi, thread: parent, target: readRendererFederationTarget(), signal: actionAbortControllerRef.current.signal });
        groupRoot = await resolveGroupRoot(parent);
      } catch (error) {
        setCreateThreadError(error instanceof Error ? error.message : String(error));
        return;
      }

      const directory = selectThreadWorkspace(parent, mode);

      const federationTarget = parent.federation?.ref.target ??
        readRendererFederationTarget();
      const groupRootInstanceId = groupRoot.federation?.ref.target
        && isRemoteFederationTarget(groupRoot.federation.ref.target)
        ? groupRoot.federation.ref.target.instanceId
        : parent.parentThreadInstanceId;
      const childOwnerInstanceId = federationTarget
        && isRemoteFederationTarget(federationTarget)
        ? federationTarget.instanceId
        : undefined;
      const parentThreadInstanceId =
        groupRootInstanceId
        && groupRootInstanceId !== childOwnerInstanceId
          ? groupRootInstanceId
          : undefined;
      const executionMode = parent.executionMode ?? "default";
      const pendingForkEnvironmentSetup = buildPendingForkEnvironmentSetup({
        directoryLabel: directory.directoryLabel,
        directoryPath: directory.directoryPath,
        mode,
        parent,
        runtime: parent.codexEnvironmentRuntime,
      });
      setCreatingThread({
        backend: parent.source,
        executionMode,
        ...(pendingForkEnvironmentSetup ? { pendingForkEnvironmentSetup } : {}),
      });
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);
      setArchiveThreadError(undefined);
      setSetThreadModelSettingsError(undefined);

      try {
        const response = await forkThreadRequest({
          backend: parent.source,
          federationTarget,
          sourceThreadId: parent.id,
          parentThreadId: groupRoot.id,
          parentThreadBackend: groupRoot.source,
          ...(parentThreadInstanceId ? { parentThreadInstanceId } : {}),
          executionMode,
          directoryKind: directory.directoryKind,
          directoryLabel: directory.directoryLabel,
          directoryPath: directory.directoryPath,
          ...(directory.branchName ? { branchName: directory.branchName } : {}),
          workMode: directory.workMode,
          model: parent.model,
          reasoningEffort: parent.reasoningEffort,
          serviceTier: parent.serviceTier,
          fastMode: parent.fastMode,
          ...(pendingForkEnvironmentSetup
            ? {
                codexEnvironmentSetupProgressKey:
                  pendingForkEnvironmentSetup.directoryKey,
              }
            : {}),
        });
        const now = Date.now();
        const linkedDirectories = response.linkedDirectory
          ? [response.linkedDirectory]
          : parent.linkedDirectories;
        const optimisticFork: NavigationThreadSummary = {
          id: response.threadId,
          title: parent.title,
          titleSource: parent.titleSource,
          summary: parent.summary,
          source: response.backend,
          projectKey:
            response.linkedDirectory?.worktreePath ??
            response.linkedDirectory?.path ??
            parent.projectKey,
          createdAt: now,
          updatedAt: now,
          inbox: {
            inInbox: true,
            reason: "new-thread",
          },
          executionMode: response.executionMode,
          model: parent.model,
          reasoningEffort: parent.reasoningEffort,
          serviceTier: parent.serviceTier,
          fastMode: parent.fastMode,
          gitBranch:
            response.gitBranch ??
            (response.workMode === "worktree" ? "HEAD" : parent.gitBranch),
          observedGitBranch:
            response.observedGitBranch ??
            (response.workMode === "worktree" ? "HEAD" : parent.observedGitBranch),
          codexEnvironmentRuntime: response.codexEnvironmentRuntime,
          linkedDirectories,
          parentThreadId: groupRoot.id,
          parentThreadBackend: groupRoot.source,
          parentThreadInstanceId,
          federation: federationTarget
            && isRemoteFederationTarget(federationTarget)
            ? {
                ref: {
                  backend: response.backend,
                  target: federationTarget,
                  threadId: response.threadId,
                },
                instanceLabel:
                  parent.federation?.instanceLabel ?? federationTarget.instanceId,
              }
            : undefined,
        };
        const nextThreadKey = buildThreadIdentityKey(response.backend, response.threadId);
        // Drop the fork directly below the card it was spawned from, and let
        // the order write land before the refresh below reads it back.
        await insertSubthreadBelowSource(
          groupRoot.source,
          groupRoot.id,
          parent.id,
          response.threadId,
          groupRoot.federation?.ref.target,
        );
        if (
          federationTarget
          && isRemoteFederationTarget(federationTarget)
          && !readRendererFederationTarget()
        ) {
          try {
            await desktopApi?.addRemoteThreadPin?.({
              ref: {
                backend: response.backend,
                target: federationTarget,
                threadId: response.threadId,
              },
              summary: optimisticFork,
              instanceLabel:
                parent.federation?.instanceLabel ?? federationTarget.instanceId,
            });
          } catch (error) {
            // The owner already created the fork. A viewer-side pin failure
            // must not report the whole fork as failed and invite a duplicate.
            console.warn("Could not add the remote fork to this thread list:", error);
          }
        }
        setOptimisticThread(optimisticFork);
        setSelectedItemKey(nextThreadKey);
        setPendingSeenThreadKey(nextThreadKey);
        await refresh(nextThreadKey, optimisticFork, true);
      } catch (error) {
        setCreateThreadError(error instanceof Error ? error.message : String(error));
      } finally {
        setCreatingThread(undefined);
      }
    },
    [
      desktopApi,
      forkThreadRequest,
      insertSubthreadBelowSource,
      refresh,
      resolveGroupRoot,
    ],
  );

  const openFederatedDirectoryLaunchpad = useCallback(
    async (
      target: FederationRemoteTarget,
      directory: NavigationDirectorySummary,
      remoteDirectories?: NavigationDirectorySummary[],
      requestRevision?: number,
    ): Promise<void> => {
      const openRevision =
        requestRevision ?? ++federatedLaunchpadOpenRevisionRef.current;
      if (!desktopApi?.ensureDirectoryLaunchpad) {
        if (federatedLaunchpadOpenRevisionRef.current === openRevision) {
          setLaunchpadError("Desktop bridge is missing ensureDirectoryLaunchpad().");
        }
        return;
      }

      setLaunchpadError(undefined);
      setCreateThreadError(undefined);
      setArchiveThreadError(undefined);
      setSetThreadExecutionModeError(undefined);
      setSetThreadModelSettingsError(undefined);

      try {
        const response = await desktopApi.ensureDirectoryLaunchpad({
          federationTarget: target,
          directoryKey: directory.key,
          directoryKind: directory.kind,
          directoryLabel: directory.label,
          directoryPath: directory.path,
          ...(directory.gitStatus ? { gitStatus: directory.gitStatus } : {}),
          currentBranch: directory.gitStatus?.currentBranch,
          preferredBackend: directory.launchpad?.backend,
        });
        if (federatedLaunchpadOpenRevisionRef.current !== openRevision) {
          return;
        }
        const launchpad = {
          ...response.launchpad,
          federationTarget: target,
        };
        const sourceDirectories = remoteDirectories
          ?? (
            federatedLaunchpad
            && federationTargetsEqual(federatedLaunchpad.target, target)
              ? federatedLaunchpad.directories
              : [directory]
          );
        const directoriesWithLaunchpad = upsertLaunchpadDirectory(
          sourceDirectories,
          launchpad,
          {
            ...(response.gitStatus !== undefined
              ? { gitStatus: response.gitStatus }
              : {}),
          },
        );
        const launchpadDirectory = directoriesWithLaunchpad.find(
          (candidate) => candidate.key === launchpad.directoryKey,
        );
        if (!launchpadDirectory) {
          throw new Error("Could not resolve the remote launchpad directory.");
        }

        setFederatedLaunchpad({
          directories: directoriesWithLaunchpad,
          directory: launchpadDirectory,
          launchpad,
          target,
        });
        setSelectedItemKey(buildFederatedLaunchpadSelectionKey(target));
      } catch (error) {
        if (federatedLaunchpadOpenRevisionRef.current === openRevision) {
          setLaunchpadError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [desktopApi, federatedLaunchpad],
  );

  const openFederatedWorkspaceLaunchpad = useCallback(
    async (target: FederationRemoteTarget): Promise<void> => {
      const openRevision = ++federatedLaunchpadOpenRevisionRef.current;
      if (!desktopApi?.getNavigationQueryPage) {
        if (federatedLaunchpadOpenRevisionRef.current === openRevision) {
          setLaunchpadError("Desktop bridge requires bounded navigation support. Upgrade this instance.");
        }
        return;
      }

      setLaunchpadError(undefined);
      try {
        const consumerId = `workspace-launchpad:${attentionViewId}:${openRevision}`;
        const page = await readNavigationQueryRange({
          request: { protocol: 2, consumer: "main-sidebar", query: { kind: "directory-index" }, pageSize: 100, federationTarget: target },
          read: (request) => desktopApi.getNavigationQueryPage!(request, consumerId),
          isCancelled: () => !mountedRef.current || federatedLaunchpadOpenRevisionRef.current !== openRevision,
          maxBytes: 8 * 1024 * 1024,
        }).finally(() => desktopApi.releaseNavigationQuery?.(consumerId));
        if (page.coverage.state !== "complete") throw new Error("The owner is still loading its directories. Retry when it is ready.");
        const ownerDirectories = page.directories ?? [];
        if (federatedLaunchpadOpenRevisionRef.current !== openRevision) {
          return;
        }
        const workspaceDirectory = ownerDirectories.find(
          (directory) => directory.kind === "workspace",
        ) ?? {
          key: ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY,
          kind: "workspace" as const,
          label: ROOT_NEW_THREAD_WORKSPACE_LABEL,
        };
        await openFederatedDirectoryLaunchpad(
          target,
          workspaceDirectory,
          ownerDirectories,
          openRevision,
        );
      } catch (error) {
        if (federatedLaunchpadOpenRevisionRef.current === openRevision) {
          setLaunchpadError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [desktopApi, openFederatedDirectoryLaunchpad, attentionViewId],
  );

  const openDirectoryLaunchpad = useCallback(
    async (
      directory: NavigationDirectorySummary,
      preferredBackend?: AppServerBackendKind
    ): Promise<void> => {
      if (!desktopApi?.ensureDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing ensureDirectoryLaunchpad().");
        return;
      }

      setLaunchpadError(undefined);
      setCreateThreadError(undefined);
      setArchiveThreadError(undefined);
      setSetThreadExecutionModeError(undefined);
      setSetThreadModelSettingsError(undefined);

      try {
        const response = await desktopApi.ensureDirectoryLaunchpad({
          federationTarget: rendererFederationTarget,
          directoryKey: directory.key,
          directoryKind: directory.kind,
          directoryLabel: directory.label,
          directoryPath: directory.path,
          ...(directory.gitStatus ? { gitStatus: directory.gitStatus } : {}),
          currentBranch: directory.gitStatus?.currentBranch,
          preferredBackend,
        });
        setLocalLaunchpads((current) => ({
          ...current,
          [directory.key]: response.launchpad,
        }));
        setState((current) => ({
          ...current,
          rows: applyLaunchpadUpdate(
            current.rows,
            response.launchpad,
            response.defaults,
            {
              ...(response.gitStatus !== undefined
                ? { gitStatus: response.gitStatus }
                : {}),
              preserveExistingDirectoryAuthority: Boolean(
                rendererFederationTarget,
              ),
            },
          ),
        }));
        setSelectedItemKey(buildLaunchpadSelectionKey(directory.key));
      } catch (error) {
        setLaunchpadError(error instanceof Error ? error.message : String(error));
      }
    },
    [desktopApi, rendererFederationTarget]
  );

  // Switch the composer to the directory-less "workspace" launchpad. Backs the
  // "Chat without a directory" row in the project picker. Reuses the existing
  // workspace pseudo-directory when the snapshot already has one, otherwise
  // synthesizes the same key/label `resolveCreateThreadTargetDirectory` falls
  // back to so both entry points land on the identical launchpad.
  const openWorkspaceLaunchpad = useCallback(
    async (preferredBackend?: AppServerBackendKind): Promise<void> => {
      const workspaceDirectory = directories.find(
        (directory) => directory.kind === "workspace"
      );
      await openDirectoryLaunchpad(
        workspaceDirectory ?? {
          key: ROOT_NEW_THREAD_WORKSPACE_LAUNCHPAD_KEY,
          kind: "workspace",
          label: ROOT_NEW_THREAD_WORKSPACE_LABEL,
        },
        preferredBackend
      );
    },
    [directories, openDirectoryLaunchpad]
  );

  const pickAndRegisterDirectory = useCallback(
    async (preferredBackend?: AppServerBackendKind): Promise<void> => {
      // Two-step OS-dialog → register-as-launchpad flow (issue #223).
      // We separate the cancel path (silent — the user closed the
      // dialog) from the validation-failure path (loud — we surface
      // the inline error so the picker can render it). The success
      // path navigates to the new directory's launchpad immediately
      // so the composer focuses the just-added directory without an
      // extra click.
      if (rendererFederationTarget) {
        return;
      }
      if (
        !desktopApi?.pickDirectoryFromDisk ||
        !desktopApi?.registerDirectoryFromDisk
      ) {
        setPickDirectoryError(
          "Desktop bridge is missing the directory picker.",
        );
        return;
      }

      setPickDirectoryError(undefined);
      setPickingDirectory(true);

      let pendingPickedDirectoryKey: string | undefined;
      try {
        const pick = await desktopApi.pickDirectoryFromDisk();
        if (pick.canceled) {
          return;
        }
        const result = await desktopApi.registerDirectoryFromDisk({
          path: pick.path,
          preferredBackend,
        });
        if (!result.ok) {
          setPickDirectoryError(result.message);
          return;
        }
        pendingPickedDirectoryKey = result.directoryKey;
        pendingPickedLaunchpadRef.current.set(result.directoryKey, result.launchpad);
        setLocalLaunchpads((current) => ({
          ...current,
          [result.directoryKey]: result.launchpad,
        }));
        setState((current) => ({
          ...current,
          rows: applyLaunchpadUpdate(
            current.rows,
            result.launchpad,
            result.defaults,
          ),
        }));
        const selectionKey = buildLaunchpadSelectionKey(result.directoryKey);
        setSelectedItemKey(selectionKey);
        await refresh(selectionKey, undefined, true);
        const pickedLaunchpad =
          pendingPickedLaunchpadRef.current.get(result.directoryKey) ??
          result.launchpad;
        setState((current) => ({
          ...current,
          rows: applyLaunchpadUpdateIfMissing(
            current.rows,
            pickedLaunchpad,
            result.defaults,
          ),
        }));
        setSelectedItemKey(selectionKey);
        await desktopApi.refreshDirectoryGitStatuses?.({
          directoryKeys: [result.directoryKey],
          force: true,
        });
      } catch (error) {
        setPickDirectoryError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        if (pendingPickedDirectoryKey) {
          pendingPickedLaunchpadRef.current.delete(pendingPickedDirectoryKey);
        }
        setPickingDirectory(false);
      }
    },
    [desktopApi, refresh, rendererFederationTarget],
  );

  const recordPickDirectoryError = useCallback((message?: string): void => {
    lastPickDirectoryErrorRef.current = message;
    setPickDirectoryError(message);
  }, []);

  const pickDirectoryForReference = useCallback(async (): Promise<
    { label: string; path: string } | undefined
  > => {
    // No-navigation sibling of pickAndRegisterDirectory: the composer's
    // reference pickers register the picked directory (so the tracked set
    // and the `@` autocomplete know it) but keep the current selection —
    // the caller mints a chip in place instead of moving to the new
    // launchpad. Same cancel-vs-failure split as the sibling: cancel is
    // silent, validation failure surfaces via `pickDirectoryError`.
    lastPickDirectoryErrorRef.current = undefined;
    if (rendererFederationTarget) {
      return undefined;
    }
    if (
      !desktopApi?.pickDirectoryFromDisk ||
      !desktopApi?.registerDirectoryFromDisk
    ) {
      recordPickDirectoryError("Desktop bridge is missing the directory picker.");
      return undefined;
    }

    recordPickDirectoryError(undefined);
    setPickingDirectory(true);
    try {
      const pick = await desktopApi.pickDirectoryFromDisk();
      if (pick.canceled) {
        return undefined;
      }
      const result = await desktopApi.registerDirectoryFromDisk({
        path: pick.path,
      });
      if (!result.ok) {
        recordPickDirectoryError(result.message);
        return undefined;
      }
      removedDirectoryKeysRef.current.delete(result.directoryKey);
      setLocalLaunchpads((current) => ({
        ...current,
        [result.directoryKey]: result.launchpad,
      }));
      setState((current) => ({
        ...current,
        rows: applyLaunchpadUpdate(
          current.rows,
          result.launchpad,
          result.defaults,
        ),
      }));
      return {
        label: result.launchpad.directoryLabel,
        path: result.launchpad.directoryPath ?? pick.path,
      };
    } catch (error) {
      recordPickDirectoryError(
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    } finally {
      setPickingDirectory(false);
    }
  }, [desktopApi, recordPickDirectoryError, rendererFederationTarget]);

  const addProjectDirectory = useCallback(async (): Promise<void> => {
    const picked = await pickDirectoryForReference();
    // Nothing on screen renders `pickDirectoryError` for this entry point,
    // so publish the outcome to the notice stack. A cancel or a success
    // records `undefined`, which takes any prior notice down.
    publishAddDirectoryError(lastPickDirectoryErrorRef.current);
    if (picked) {
      updateBrowseMode("directories");
      await refresh();
    }
  }, [
    pickDirectoryForReference,
    publishAddDirectoryError,
    refresh,
    updateBrowseMode,
  ]);

  const pickAndAttachDirectoryToSelectedThread = useCallback(async (): Promise<void> => {
    if (rendererFederationTarget) {
      return;
    }
    if (
      !desktopApi?.pickDirectoryFromDisk ||
      !desktopApi.attachDirectoryToThread
    ) {
      setPickDirectoryError("Desktop bridge is missing the directory picker.");
      return;
    }
    if (!selectedThread) {
      setPickDirectoryError("Select a thread before adding a directory.");
      return;
    }

    setPickDirectoryError(undefined);
    setPickingDirectory(true);
    try {
      const pick = await desktopApi.pickDirectoryFromDisk();
      if (pick.canceled) {
        return;
      }
      const result = await desktopApi.attachDirectoryToThread({
        backend: selectedThread.source,
        threadId: selectedThread.id,
        path: pick.path,
        preferredBackend: selectedThread.source,
      });
      if (!result.ok) {
        setPickDirectoryError(result.message);
        return;
      }
      await refresh(buildThreadIdentityKey(selectedThread.source, selectedThread.id));
    } catch (error) {
      setPickDirectoryError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setPickingDirectory(false);
    }
  }, [desktopApi, refresh, rendererFederationTarget, selectedThread]);

  const attachDirectoryPathsToThread = useCallback(
    async (
      target: {
        backend: AppServerBackendKind;
        federationTarget?: FederationTarget;
        threadId: string;
      },
      paths: string[],
    ): Promise<void> => {
      // Composer `@`-reference links (no OS dialog — the paths are already
      // known). The caller names the thread explicitly so a selection
      // change during the send cannot misdirect the attach. Failures stay
      // non-fatal: the sent turn carries the path as text either way, so a
      // failed link only loses the association.
      if (!desktopApi?.attachDirectoryToThread || paths.length === 0) {
        return;
      }

      let attachedAny = false;
      for (const path of paths) {
        try {
          const result = await desktopApi.attachDirectoryToThread({
            backend: target.backend,
            federationTarget:
              target.federationTarget ?? rendererFederationTarget,
            threadId: target.threadId,
            path,
            preferredBackend: target.backend,
          });
          if (result.ok) {
            attachedAny = true;
          } else {
            console.warn(
              `Could not link referenced directory ${path}: ${result.message}`,
            );
          }
        } catch (error) {
          console.warn(
            `Could not link referenced directory ${path}:`,
            error,
          );
        }
      }
      if (attachedAny) {
        try {
          await refresh(
            buildThreadIdentityKey(target.backend, target.threadId),
          );
        } catch (error) {
          // The attach itself landed and the threadDirectories/updated
          // event will still reach the snapshot; a failed refresh here is
          // not worth surfacing (and the caller fire-and-forgets us).
          console.warn("Could not refresh after linking directories:", error);
        }
      }
    },
    [desktopApi, refresh, rendererFederationTarget],
  );

  const clearPickDirectoryError = useCallback((): void => {
    setPickDirectoryError(undefined);
  }, []);

  const updateDirectoryLaunchpad = useCallback(
    async (
      directoryKey: string,
      patch: Parameters<NonNullable<DesktopApi["updateDirectoryLaunchpad"]>>[0]["patch"],
      options?: { stickySettingsChanged?: boolean }
    ): Promise<void> => {
      if (!desktopApi?.updateDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing updateDirectoryLaunchpad().");
        return;
      }

      setLaunchpadError(undefined);
      const federatedSelection =
        activeFederatedLaunchpad
        && activeFederatedLaunchpad.launchpad.directoryKey === directoryKey
          ? activeFederatedLaunchpad
          : undefined;
      const launchpadUpdateKey = federatedSelection
        ? `${federatedSelection.target.instanceId}:${directoryKey}`
        : directoryKey;
      const revision =
        (launchpadUpdateRevisionRef.current.get(launchpadUpdateKey) ?? 0) + 1;
      launchpadUpdateRevisionRef.current.set(launchpadUpdateKey, revision);

      if (federatedSelection) {
        const applyFederatedPatch = (
          launchpad: NavigationLaunchpadDraft,
        ): NavigationLaunchpadDraft => ({
          ...applyNavigationLaunchpadProviderSettingsPatch<NavigationLaunchpadDraft>(
            launchpad,
            patch,
          ),
          directoryKey,
          federationTarget: federatedSelection.target,
          updatedAt: Date.now(),
        });
        setFederatedLaunchpad((current) =>
          current
          && federationTargetsEqual(current.target, federatedSelection.target)
          && current.launchpad.directoryKey === directoryKey
            ? {
                ...current,
                launchpad: applyFederatedPatch(current.launchpad),
              }
            : current,
        );

        try {
          const response = await desktopApi.updateDirectoryLaunchpad({
            directoryKey,
            patch,
            stickySettingsChanged: options?.stickySettingsChanged,
          });
          if (launchpadUpdateRevisionRef.current.get(launchpadUpdateKey) !== revision) {
            return;
          }
          setFederatedLaunchpad((current) =>
            current
            && federationTargetsEqual(current.target, federatedSelection.target)
            && current.launchpad.directoryKey === directoryKey
              ? {
                  ...current,
                  launchpad: {
                    ...mergeLaunchpadUpdateResponse(
                      current.launchpad,
                      response.launchpad,
                      patch,
                    ),
                    federationTarget: federatedSelection.target,
                  },
                }
              : current,
          );
        } catch (error) {
          if (launchpadUpdateRevisionRef.current.get(launchpadUpdateKey) !== revision) {
            return;
          }
          setLaunchpadError(error instanceof Error ? error.message : String(error));
        }
        return;
      }

      setState((current) => {
        const currentResponse = current.rows;
        const currentLaunchpad = loadedDirectoryRows(currentResponse).find(
          (directory) => directory.key === directoryKey
        )?.launchpad;
        if (!currentResponse || !currentLaunchpad) {
          return current;
        }

        return {
          ...current,
          rows: applyLaunchpadUpdate(
            currentResponse,
            {
              ...applyNavigationLaunchpadProviderSettingsPatch<NavigationLaunchpadDraft>(
                currentLaunchpad,
                patch,
              ),
              directoryKey,
              updatedAt: Date.now(),
            },
            currentResponse.launchpadDefaults
          ),
        };
      });
      setLocalLaunchpads((current) => {
        const currentLaunchpad = current[directoryKey];
        if (!currentLaunchpad) {
          return current;
        }
        return {
          ...current,
          [directoryKey]: {
            ...applyNavigationLaunchpadProviderSettingsPatch<NavigationLaunchpadDraft>(
              currentLaunchpad,
              patch,
            ),
            directoryKey,
            updatedAt: Date.now(),
          },
        };
      });
      const pendingPickedLaunchpad = pendingPickedLaunchpadRef.current.get(directoryKey);
      if (pendingPickedLaunchpad) {
        pendingPickedLaunchpadRef.current.set(directoryKey, {
          ...applyNavigationLaunchpadProviderSettingsPatch<NavigationLaunchpadDraft>(
            pendingPickedLaunchpad,
            patch,
          ),
          directoryKey,
          updatedAt: Date.now(),
        });
      }

      try {
        const response = await desktopApi.updateDirectoryLaunchpad({
          directoryKey,
          patch,
          stickySettingsChanged: options?.stickySettingsChanged,
        });
        if (launchpadUpdateRevisionRef.current.get(launchpadUpdateKey) !== revision) {
          return;
        }
        setLocalLaunchpads((current) =>
          current[directoryKey]
            ? {
                ...current,
                [directoryKey]: mergeLaunchpadUpdateResponse(
                  current[directoryKey],
                  response.launchpad,
                  patch,
                  {
                    preserveOwnerCodexEnvironmentMetadata:
                      isRendererFederationWindow,
                  },
                ),
              }
            : current
        );
        setState((current) => ({
          ...current,
          rows: applyLaunchpadUpdate(
            current.rows,
            mergeLaunchpadUpdateResponse(
              loadedDirectoryRows(current.rows).find(
                (directory) => directory.key === directoryKey
              )?.launchpad,
              response.launchpad,
              patch,
              {
                preserveOwnerCodexEnvironmentMetadata:
                  isRendererFederationWindow,
              },
            ),
            response.defaults
          ),
        }));
        const nextPendingPickedLaunchpad =
          pendingPickedLaunchpadRef.current.get(directoryKey);
        if (nextPendingPickedLaunchpad) {
          pendingPickedLaunchpadRef.current.set(
            directoryKey,
            mergeLaunchpadUpdateResponse(
              nextPendingPickedLaunchpad,
              response.launchpad,
              patch,
              {
                preserveOwnerCodexEnvironmentMetadata:
                  isRendererFederationWindow,
              },
            ),
          );
        }
      } catch (error) {
        if (launchpadUpdateRevisionRef.current.get(launchpadUpdateKey) !== revision) {
          return;
        }
        setLaunchpadError(error instanceof Error ? error.message : String(error));
      }
    },
    [activeFederatedLaunchpad, desktopApi, isRendererFederationWindow]
  );

  const resetDirectoryLaunchpad = useCallback(
    async (directoryKey: string): Promise<void> => {
      if (!desktopApi?.resetDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing resetDirectoryLaunchpad().");
        return;
      }

      setLaunchpadError(undefined);

      try {
        if (
          activeFederatedLaunchpad
          && activeFederatedLaunchpad.launchpad.directoryKey === directoryKey
        ) {
          await desktopApi.resetDirectoryLaunchpad({ directoryKey });
          setFederatedLaunchpad(undefined);
          setSelectedItemKey((current) =>
            current === buildFederatedLaunchpadSelectionKey(
              activeFederatedLaunchpad.target,
            )
              ? undefined
              : current,
          );
          return;
        }
        const response = await desktopApi.resetDirectoryLaunchpad({ directoryKey });
        setLocalLaunchpads((current) => {
          if (!current[directoryKey]) {
            return current;
          }
          const next = { ...current };
          delete next[directoryKey];
          return next;
        });
        setState((current) => ({
          ...current,
          rows: applyLaunchpadReset(
            current.rows,
            response.directoryKey,
            response.defaults
          ),
        }));
        setSelectedItemKey((current) =>
          current === buildLaunchpadSelectionKey(directoryKey)
            ? getFallbackSelectionKey(
                state.rows
                  ? applyLaunchpadReset(state.rows, response.directoryKey, response.defaults)!
                  : {
                      threadRows: indexLoadedThreadRows(threads),
                      
                      directoryRows: indexLoadedDirectoryRows(directories),
                      launchpadDefaults: response.defaults,
                    },
                optimisticThread
                  ? buildThreadIdentityKey(optimisticThread.source, optimisticThread.id)
                  : undefined
              )
            : current
        );
      } catch (error) {
        setLaunchpadError(error instanceof Error ? error.message : String(error));
      }
    },
    [
      activeFederatedLaunchpad,
      desktopApi,
      directories,
      optimisticThread,
      state.rows,
      threads,
    ]
  );

  const markDirectoriesSeen = useCallback(async (directoryKeys: string[]): Promise<void> => {
    onThreadActionErrorRef.current?.({ kind: "mark-directory-read", message: undefined });
    try {
      if (!desktopApi?.markNavigationDirectorySeen) throw new Error("Upgrade this instance to mark directory membership read on its owner.");
      for (const directoryKey of new Set(directoryKeys)) {
        await desktopApi.markNavigationDirectorySeen({ directoryKey, federationTarget: readRendererFederationTarget() });
      }
      await refresh();
    } catch (error) {
      onThreadActionErrorRef.current?.({ kind: "mark-directory-read", message: error instanceof Error ? error.message : String(error) });
    }
  }, [desktopApi, refresh]);

  /** The owner validates complete membership before local state is removed. */
  const removeDirectory = useCallback(
    async (directoryKey: string): Promise<void> => {
      if (!desktopApi?.removeNavigationDirectory) {
        setLaunchpadError("Upgrade this instance to remove a directory through owner navigation.");
        return;
      }

      const directory = directories.find(
        (candidate) => candidate.key === directoryKey,
      );
      if (
        !directory
        || isSubthreadLaunchpadKey(directoryKey)
      ) {
        return;
      }

      setLaunchpadError(undefined);
      try {
        await desktopApi.removeNavigationDirectory({
          directoryKey, federationTarget: readRendererFederationTarget(),
        });
        removedDirectoryKeysRef.current.add(directoryKey);
        boundedNavigation.invalidate();
        setLocalLaunchpads((current) => {
          if (!current[directoryKey]) {
            return current;
          }
          const next = { ...current };
          delete next[directoryKey];
          return next;
        });
        setState((current) => {
          if (!current.rows) {
            return current;
          }
          return {
            ...current,
            rows: {
              ...current.rows,
              directoryRows: indexLoadedDirectoryRows(loadedDirectoryRows(current.rows).filter(
                (directory) =>
                  directory.key !== directoryKey,
              )),
            },
          };
        });
        setSelectedItemKey((current) =>
          current === buildLaunchpadSelectionKey(directoryKey) ? undefined : current,
        );
      } catch (error) {
        setLaunchpadError(error instanceof Error ? error.message : String(error));
        await refresh();
      }
    },
    [desktopApi, directories, refresh, boundedNavigation.invalidate],
  );

  const materializeDirectoryLaunchpad = useCallback(
    async (
      directoryKey: string,
      input?: AppServerTurnInputItem[],
      collaborationMode?: AppServerCollaborationModeRequest,
      reviewTarget?: AppServerReviewTarget,
      parentThreadId?: string,
      extraDirectoryPaths?: string[],
      scheduledFor?: number,
      onMaterialized?: (thread: NavigationThreadSummary) => void,
    ): Promise<void> => {
      if (!desktopApi?.materializeDirectoryLaunchpad) {
        setLaunchpadError("Desktop bridge is missing materializeDirectoryLaunchpad().");
        return;
      }

      const selectionKeyAtMaterializationStart = selectedItemKeyRef.current;
      const federatedSelection =
        activeFederatedLaunchpad
        && activeFederatedLaunchpad.launchpad.directoryKey === directoryKey
          ? activeFederatedLaunchpad
          : undefined;
      const directory = federatedSelection?.directory
        ?? directories.find((candidate) => candidate.key === directoryKey);
      let launchpad = federatedSelection?.launchpad ?? directory?.launchpad;
      let initialConfiguration: Awaited<ReturnType<NonNullable<DesktopApi["getNavigationLaunchpadConfig"]>>> | undefined;
      if (!launchpad && directory?.launchpadPresent && desktopApi.getNavigationLaunchpadConfig) {
        try {
          initialConfiguration = await desktopApi.getNavigationLaunchpadConfig({ protocol: 2, directoryKey,
            federationTarget: federatedSelection?.target ?? rendererFederationTarget });
          if (initialConfiguration.protocol !== 2 || initialConfiguration.unchanged
            || initialConfiguration.directoryKey !== directoryKey || !initialConfiguration.defaults) {
            throw new Error("Launchpad configuration is not ready. The draft has been retained.");
          }
          const saved = draftStore?.get(`launchpad:${directoryKey}`);
          if (initialConfiguration.launchpad) launchpad = { ...initialConfiguration.launchpad,
            prompt: saved?.draft ?? "", imageAttachments: saved?.imageAttachments, fileAttachments: saved?.fileAttachments };
        } catch (error) {
          setLaunchpadError(error instanceof Error ? error.message : String(error));
          throw error;
        }
      }
      if (!launchpad) {
        setLaunchpadError(`No launchpad found for ${directoryKey}.`);
        return;
      }

      setLaunchpadError(undefined);

      // The draft carries the group root (sub-threading a child re-parents to
      // the root); prefer it over the key-parsed source so the new thread links
      // to the root and renders one level deep.
      const launchpadSelectionKey = federatedSelection
        ? buildFederatedLaunchpadSelectionKey(federatedSelection.target)
        : buildLaunchpadSelectionKey(directoryKey);
      if (pendingLaunchpadCreationsRef.current.has(launchpadSelectionKey)) {
        throw new Error("This thread is already starting.");
      }
      const pendingCreation: PendingLaunchpadCreation = {
        federatedSession: federatedSelection,
        selectionKey: launchpadSelectionKey,
        directoryKey,
        title: input?.find((item) => item.type === "text")?.text
          ?? launchpad.prompt ?? "New thread",
        input: input ?? [],
      };
      pendingLaunchpadCreationsRef.current.set(launchpadSelectionKey, pendingCreation);
      setPendingLaunchpadCreations([...pendingLaunchpadCreationsRef.current.values()]);
      try {
        const materializeParentThreadId =
          parentThreadId ??
          launchpad.parentThreadId ??
          getParentThreadIdFromSubthreadLaunchpadKey(directoryKey);
        const materializeParentThreadBackend =
          launchpad.parentThreadBackend ?? launchpad.backend;
        const materializeParentThreadInstanceId =
          launchpad.parentThreadInstanceId;
        const federationTarget =
          launchpad.federationTarget ?? readRendererFederationTarget();
        if (!desktopApi.getNavigationLaunchpadConfig) throw new Error("Upgrade this instance to load launchpad configuration before sending.");
        const configuration = initialConfiguration ?? await desktopApi.getNavigationLaunchpadConfig({ protocol: 2, directoryKey, federationTarget });
        if (configuration.protocol !== 2 || configuration.unchanged || !configuration.defaults || configuration.directoryKey !== directoryKey) {
          throw new Error("Launchpad configuration is not ready. The draft has been retained.");
        }
        let response: Awaited<ReturnType<NonNullable<DesktopApi["materializeDirectoryLaunchpad"]>>>;
        try {
          response = await desktopApi.materializeDirectoryLaunchpad({
            directoryKey,
            federationTarget,
            launchpad,
            input,
            collaborationMode,
            reviewTarget,
            scheduledFor,
            ...(materializeParentThreadId
              ? {
                  parentThreadId: materializeParentThreadId,
                  parentThreadBackend: materializeParentThreadBackend,
                  ...(materializeParentThreadInstanceId
                    ? { parentThreadInstanceId: materializeParentThreadInstanceId }
                    : {}),
                }
              : {}),
          });
        } catch (error) {
          setLaunchpadError(error instanceof Error ? error.message : String(error));
          throw error;
        }
        let localDraftResetFailure: string | undefined;
        if (federationTarget && desktopApi.resetDirectoryLaunchpad) {
          try {
            // Remote launchpads are composed and persisted on the viewer, then
            // sent in full to the owning instance for materialization. The owner
            // clears its overlay row as part of that operation, but it cannot
            // clear the viewer's local copy. Remove that copy after success so
            // reopening the launchpad cannot resurrect the submitted message.
            await desktopApi.resetDirectoryLaunchpad({ directoryKey });
          } catch (error) {
            localDraftResetFailure =
              error instanceof Error ? error.message : String(error);
          }
        }
        const optimisticMaterializedThread = buildOptimisticThreadFromLaunchpad({
          directory,
          launchpad,
          backend: response.backend,
          threadId: response.threadId,
          federation: federationTarget
            && isRemoteFederationTarget(federationTarget)
            ? {
                ref: {
                  backend: response.backend,
                  target: federationTarget,
                  threadId: response.threadId,
                },
                instanceLabel:
                  readRendererFederationLabel() ?? federationTarget.instanceId,
              }
            : undefined,
          executionMode: response.executionMode,
          workMode: response.workMode,
          codexEnvironmentRuntime: response.codexEnvironmentRuntime,
          optimisticUserMessage: response.turnStartFailure
            || response.scheduledAction
            ? undefined
            : buildOptimisticUserMessage(input),
          optimisticActiveTurn: response.turnId && !response.turnStartFailure
            ? {
                id: response.turnId,
                statusText: reviewTarget
                  ? "Reviewing"
                  : collaborationMode
                    ? "Planning"
                    : "Thinking",
                startedAt: Date.now(),
                ...(reviewTarget
                  ? { reviewDisplayText: reviewDisplayTextFromTarget(reviewTarget) }
                  : {}),
              }
            : undefined,
          parentThreadId: materializeParentThreadId,
          parentThreadBackend: materializeParentThreadId
            ? materializeParentThreadBackend
            : undefined,
          parentThreadInstanceId: materializeParentThreadId
            ? materializeParentThreadInstanceId
            : undefined,
          pinnedRank: response.pinnedRank,
          scheduledStart: response.scheduledAction
            ? {
                actionId: response.scheduledAction.id,
                scheduledFor: response.scheduledAction.scheduledFor,
                state: "scheduled",
              }
            : undefined,
        });
        const observedThreadNameEntry = threadNameObservationsRef.current.get(
          federationTarget
            ? federatedThreadIdentityKey({
                backend: response.backend,
                target: federationTarget,
                threadId: response.threadId,
              })
            : buildThreadIdentityKey(response.backend, response.threadId),
        );
        const namedOptimisticMaterializedThread = observedThreadNameEntry
          ? {
              ...optimisticMaterializedThread,
              title: observedThreadNameEntry.threadName,
              titleSource: observedThreadNameEntry.titleSource,
            }
          : optimisticMaterializedThread;
        if (
          federationTarget
          && isRemoteFederationTarget(federationTarget)
          && !readRendererFederationTarget()
        ) {
          try {
            await desktopApi.addRemoteThreadPin?.({
              ref: {
                backend: response.backend,
                target: federationTarget,
                threadId: response.threadId,
              },
              summary: namedOptimisticMaterializedThread,
              instanceLabel:
                namedOptimisticMaterializedThread.federation?.instanceLabel
                ?? federationTarget.instanceId,
            });
          } catch (error) {
            // Materialization already succeeded on the owner. Keep the created
            // thread selected even if this viewer cannot persist its list entry.
            console.warn("Could not add the remote thread to this thread list:", error);
          }
        }
        const nextThreadKey = threadSummaryIdentityKey(
          namedOptimisticMaterializedThread,
        );
        // Sub-thread launchpads drop the new child directly below their source
        // card. Plain new-thread launchpads have no parent and skip this. Await
        // so the order write commits before the refresh below reads it back.
        if (materializeParentThreadId) {
          const subthreadOrderTarget = materializeParentThreadInstanceId
            ? { scope: "remote" as const, instanceId: materializeParentThreadInstanceId }
            : federationTarget;
          await insertSubthreadBelowSource(
            materializeParentThreadBackend,
            materializeParentThreadId,
            launchpad.sourceThreadId ?? materializeParentThreadId,
            response.threadId,
            subthreadOrderTarget,
          );
        }
        if (federatedSelection) {
          setFederatedLaunchpad((current) =>
            current
            && federationTargetsEqual(current.target, federatedSelection.target)
            && current.launchpad.directoryKey === directoryKey
              ? undefined
              : current,
          );
        } else {
          setLocalLaunchpads((current) => {
            if (!current[directoryKey]) {
              return current;
            }
            const next = { ...current };
            delete next[directoryKey];
            return next;
          });
        }
        onMaterialized?.(namedOptimisticMaterializedThread);
        const shouldSelectMaterializedThread =
          selectedItemKeyRef.current === selectionKeyAtMaterializationStart;
        const shouldProjectOptimisticThread =
          shouldSelectMaterializedThread || !optimisticThreadRef.current;
        setOptimisticThread((current) =>
          shouldSelectMaterializedThread || !current
            ? namedOptimisticMaterializedThread
            : current
        );
        if (shouldSelectMaterializedThread) {
          setSelectedItemKey(nextThreadKey);
          setPendingSeenThreadKey(nextThreadKey);
        }
        if (response.turnStartFailure) {
          setLaunchpadError(response.turnStartFailure.message);
        } else if (response.autoPinFailure) {
          setLaunchpadError(response.autoPinFailure.message);
        } else if (localDraftResetFailure) {
          setLaunchpadError(
            `Thread started, but the saved launchpad draft could not be cleared: ${localDraftResetFailure}`,
          );
        }
        // Link composer `@`-referenced directories to the just-created
        // thread before the refresh below so the snapshot comes back with
        // them. Non-fatal per path — the turn already carries the path as
        // text, so a failed link only loses the sidebar association.
        if (extraDirectoryPaths && extraDirectoryPaths.length > 0) {
          for (const path of extraDirectoryPaths) {
            try {
              const attachResult = await desktopApi.attachDirectoryToThread?.({
                backend: response.backend,
                federationTarget,
                threadId: response.threadId,
                path,
                preferredBackend: response.backend,
              });
              if (attachResult && !attachResult.ok) {
                console.warn(
                  `Could not link referenced directory ${path}: ${attachResult.message}`,
                );
              }
            } catch (error) {
              console.warn(`Could not link referenced directory ${path}:`, error);
            }
          }
        }
        if (!federatedSelection) {
          setState((current) => ({
            ...current,
            rows: current.rows
              ? applyLaunchpadReset(
                  current.rows,
                  directoryKey,
                  current.rows.launchpadDefaults
                )
              : current.rows,
          }));
        }
        try {
          await refresh(
            shouldSelectMaterializedThread ? nextThreadKey : undefined,
            shouldProjectOptimisticThread
              ? namedOptimisticMaterializedThread
              : undefined,
          );
        } catch (error) {
          setLaunchpadError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        pendingLaunchpadCreationsRef.current.delete(launchpadSelectionKey);
        setPendingLaunchpadCreations([...pendingLaunchpadCreationsRef.current.values()]);
      }
    },
    [draftStore, rendererFederationTarget,
      activeFederatedLaunchpad,
      desktopApi,
      directories,
      insertSubthreadBelowSource,
      refresh,
    ]
  );

  /**
   * Cancel an open launchpad composer (the "Cancel" button next to "Start
   * thread"). Drops the draft and, for a sub-thread composer, returns the
   * selection to the source card the user invoked it from.
   */
  const discardLaunchpad = useCallback((directoryKey: string): boolean => {
    // A previous discard failure is stale the moment the operator tries
    // again; clear it so a retry that succeeds takes the toast down.
    publishDiscardLaunchpadError();
    if (
      activeFederatedLaunchpad
      && activeFederatedLaunchpad.launchpad.directoryKey === directoryKey
    ) {
      const isRegisteredDirectory =
        activeFederatedLaunchpad.launchpad.registeredAt !== undefined;
      setFederatedLaunchpad(undefined);
      setSelectedItemKey((current) =>
        current === buildFederatedLaunchpadSelectionKey(
          activeFederatedLaunchpad.target,
        )
          ? undefined
          : current,
      );

      const handleDiscardError = (error: unknown): void => {
        publishDiscardLaunchpadError(error);
      };
      if (isRegisteredDirectory) {
        void desktopApi
          ?.updateDirectoryLaunchpad?.({
            directoryKey,
            patch: { prompt: "", imageAttachments: [], editorDocument: undefined },
          })
          .catch(handleDiscardError);
      } else {
        void desktopApi
          ?.resetDirectoryLaunchpad?.({ directoryKey })
          .catch(handleDiscardError);
      }
      return false;
    }

    // Read from the merged `directories` memo, not the raw snapshot: the
    // main-process snapshot deliberately omits sub-thread launchpads, so after
    // an authoritative refresh they exist only in `localLaunchpads`. Sourcing
    // from the raw snapshot would lose `sourceThreadId` (which is never
    // persisted anyway) and drop the user to no selection instead of returning
    // them to the card they composed from. Mirrors materializeDirectoryLaunchpad.
    const launchpad = directories.find(
      (candidate) => candidate.key === directoryKey,
    )?.launchpad;
    const sourceThreadId = launchpad?.sourceThreadId;
    const sourceBackend = launchpad?.backend;
    const restoresSourceThread = Boolean(sourceThreadId && sourceBackend);
    // An explicitly-registered directory (user added it, or it already holds
    // threads) must stay in the Directories list — Cancel only discards its
    // un-submitted message. Everything else (sub-thread launchpads, transient
    // launchpad-only rows) exists solely because of the draft, so drop the row
    // entirely instead of leaving it behind as a phantom directory entry.
    const isRegisteredDirectory = launchpad?.registeredAt !== undefined;

    setLocalLaunchpads((current) => {
      if (!current[directoryKey]) {
        return current;
      }
      const next = { ...current };
      delete next[directoryKey];
      return next;
    });
    setState((current) => ({
      ...current,
      rows: current.rows
        ? applyLaunchpadReset(
            current.rows,
            directoryKey,
            current.rows.launchpadDefaults,
          )
        : current.rows,
    }));

    setSelectedItemKey(
      sourceThreadId && sourceBackend
        ? buildThreadIdentityKey(sourceBackend, sourceThreadId)
        : undefined,
    );

    // Persist the discard so the overlay row can't rehydrate the cancelled
    // draft on the next open (or after a refresh / restart / in another window).
    // The in-memory reset above only affects this render.
    const handleDiscardError = (error: unknown): void => {
      publishDiscardLaunchpadError(error);
    };
    if (isRegisteredDirectory) {
      // Keep the registered directory (and its remembered sticky settings);
      // clear just the composed message.
      void desktopApi
        ?.updateDirectoryLaunchpad?.({
          directoryKey,
          patch: { prompt: "", imageAttachments: [], editorDocument: undefined },
        })
        .catch(handleDiscardError);
    } else {
      void desktopApi
        ?.resetDirectoryLaunchpad?.({ directoryKey })
        .catch(handleDiscardError);
    }
    return restoresSourceThread;
  }, [
    activeFederatedLaunchpad,
    desktopApi,
    directories,
    publishDiscardLaunchpadError,
  ]);

  const archiveThread = useCallback(
    async (
      thread: NavigationThreadSummary,
      options?: ArchiveThreadOptions,
    ): Promise<void> => {
      if (!archiveThreadRequest) {
        setArchiveThreadError("Desktop bridge is missing archiveThread().");
        return;
      }

      const threadKey = threadSummaryIdentityKey(thread);
      const optimisticThreadKey = optimisticThread
        ? threadSummaryIdentityKey(optimisticThread)
        : undefined;
      let targetThreads: NavigationArchiveMember[];
      try {
        targetThreads = options?.includeSubthreads
          ? await readNavigationArchiveGroup({ api: desktopApi ?? {}, thread, windowTarget: readRendererFederationTarget() })
          : [thread];
      } catch (error) {
        setArchiveThreadError(error instanceof Error ? error.message : String(error));
        return;
      }
      const targetThreadKeys = new Set(
        targetThreads.map((target) =>
          threadSummaryIdentityKey(target)
        )
      );

      for (const targetKey of targetThreadKeys) {
        suppressedArchivedThreadKeysRef.current.add(targetKey);
      }
      setArchiveThreadError(undefined);
      setArchiveThreadNotice(undefined);
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);
      setSetThreadExecutionModeError(undefined);
      setSetThreadModelSettingsError(undefined);
      setState((current) => ({
        ...current,
        rows: targetThreads.reduce(
          (snapshot, target) =>
            removeThreadFromLoadedRows(snapshot, {
              backend: target.source,
              federationTarget: target.federation?.ref.target
                ?? readRendererFederationTarget(),
              threadId: target.id,
            }),
          options?.includeSubthreads
            ? current.rows
            : ungroupChildThreadsInLoadedRows(current.rows, {
                parent: thread,
              })
        ),
      }));
      setSelectedItemKey((current) =>
        current && targetThreadKeys.has(current)
          ? getFallbackSelectionAfterRemoval(state.rows, {
              backend: thread.source,
              federationTarget: thread.federation?.ref.target
                ?? readRendererFederationTarget(),
              threadId: thread.id,
              optimisticThreadKey,
            })
          : current
      );
      setRetainedUnreadThread((current) =>
        current && targetThreadKeys.has(threadSummaryIdentityKey(current))
          ? undefined
          : current
      );
      setOptimisticThread((current) =>
        current && targetThreadKeys.has(threadSummaryIdentityKey(current))
          ? undefined
          : current
      );

      const archivedKeys = new Set<string>();
      try {
        for (const target of targetThreads) {
          const federationTarget = target.federation?.ref.target
            ?? readRendererFederationTarget();
          const response = await archiveThreadRequest({
            backend: target.source,
            threadId: target.id,
            ...(target.expectedParent !== undefined ? { expectedParent: target.expectedParent } : {}),
            ...(federationTarget ? { federationTarget } : {}),
          });
          const cleanupNotice = formatArchiveCleanupNotice(response.cleanup);
          archivedKeys.add(threadSummaryIdentityKey(target));
          if (cleanupNotice) {
            setArchiveThreadNotice(cleanupNotice);
          }
          if (target.federation?.ref && removeRemoteThreadPinRequest) {
            // Archiving succeeds on the owner, but viewer-owned remote pins
            // are deliberately local state. Remove that cached mount too or
            // the next refresh resurrects the archived row from its snapshot.
            await removeRemoteThreadPinRequest({
              ref: target.federation.ref,
            });
          }
        }
        await refresh();
      } catch (error) {
        for (const targetKey of targetThreadKeys) {
          if (!archivedKeys.has(targetKey)) suppressedArchivedThreadKeysRef.current.delete(targetKey);
        }
        setArchiveThreadError(error instanceof Error ? error.message : String(error));
        await refresh(archivedKeys.has(threadKey) ? undefined : threadKey, undefined, !archivedKeys.has(threadKey));
      }
    },
    [
      archiveThreadRequest,
      desktopApi,
      optimisticThread,
      refresh,
      removeRemoteThreadPinRequest,
      state.rows,
    ]
  );

  const archiveWorktree = useCallback(
    async (
      thread: NavigationThreadSummary,
      directory: LinkedDirectorySummary
    ): Promise<void> => {
      if (!archiveWorktreeRequest) {
        setWorktreeArchiveError("Desktop bridge is missing archiveWorktree().");
        return;
      }

      setWorktreeArchiveError(undefined);
      setArchiveThreadError(undefined);

      try {
        thread = await readNavigationActionThread({ api: desktopApi, thread, target: readRendererFederationTarget(), signal: actionAbortControllerRef.current.signal });
        if (thread.federation?.ref.target.scope === "remote") {
          throw new Error("Open this thread on its owning instance to manage its worktree archives.");
        }
        const authoritativeDirectory = thread.linkedDirectories.find((candidate) =>
          candidate.path === directory.path && candidate.worktreePath === directory.worktreePath);
        if (!authoritativeDirectory) throw new Error("This worktree is no longer linked to the thread. Refresh before archiving it.");
        const worktreePath = authoritativeDirectory.worktreePath ?? authoritativeDirectory.path;
        await archiveWorktreeRequest({
          backend: thread.source,
          threadId: thread.id,
          repositoryPath: directory.path,
          worktreePath,
        });
        await refresh(threadSummaryIdentityKey(thread));
      } catch (error) {
        setWorktreeArchiveError(error instanceof Error ? error.message : String(error));
      }
    },
    [desktopApi, archiveWorktreeRequest, refresh]
  );

  const restoreWorktree = useCallback(
    async (
      thread: NavigationThreadSummary,
      snapshotRef: string,
      worktreePath: string
    ): Promise<void> => {
      if (!restoreWorktreeRequest) {
        setWorktreeArchiveError("Desktop bridge is missing restoreWorktree().");
        return;
      }

      setWorktreeArchiveError(undefined);
      setArchiveThreadError(undefined);

      try {
        thread = await readNavigationActionThread({ api: desktopApi, thread, target: readRendererFederationTarget(), signal: actionAbortControllerRef.current.signal });
        if (thread.federation?.ref.target.scope === "remote") {
          throw new Error("Open this thread on its owning instance to manage its worktree archives.");
        }
        await restoreWorktreeRequest({
          backend: thread.source,
          threadId: thread.id,
          snapshotRef,
          worktreePath,
        });
        await refresh(threadSummaryIdentityKey(thread));
      } catch (error) {
        setWorktreeArchiveError(error instanceof Error ? error.message : String(error));
      }
    },
    [desktopApi, refresh, restoreWorktreeRequest]
  );

  const handoffThreadWorkspace = useCallback(
    async (
      thread: NavigationThreadSummary,
      request: Omit<HandoffThreadWorkspaceRequest, "backend" | "threadId">
    ): Promise<void> => {
      if (!handoffThreadWorkspaceRequest) {
        const error = new Error("Desktop bridge is missing handoffThreadWorkspace().");
        setWorktreeArchiveError(error.message);
        throw error;
      }

      setWorktreeArchiveError(undefined);
      setArchiveThreadError(undefined);

      try {
        thread = await readNavigationActionThread({ api: desktopApi, thread, target: readRendererFederationTarget(), signal: actionAbortControllerRef.current.signal });
        await handoffThreadWorkspaceRequest({
          ...request,
          backend: thread.source,
          federationTarget: thread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: thread.id,
        });
        await refresh(threadSummaryIdentityKey(thread));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setWorktreeArchiveError(message);
        throw error;
      }
    },
    [desktopApi, handoffThreadWorkspaceRequest, refresh]
  );

  const renameThread = useCallback(
    async (thread: NavigationThreadSummary, name: string): Promise<void> => {
      const nextName = name.trim();
      const threadKey = threadSummaryIdentityKey(thread);

      if (!nextName) {
        setRenameThreadError("Thread name cannot be blank.");
        return;
      }

      if (!renameThreadRequest) {
        setRenameThreadError("Desktop bridge is missing renameThread().");
        return;
      }

      setRenameThreadError(undefined);
      setArchiveThreadError(undefined);
      setCreateThreadError(undefined);
      setLaunchpadError(undefined);
      setSetThreadExecutionModeError(undefined);
      setSetThreadModelSettingsError(undefined);
      setState((current) => ({
        ...current,
        rows: applyThreadNameUpdate(current.rows, {
          backend: thread.source,
          federationTarget: thread.federation?.ref.target,
          threadId: thread.id,
          threadName: nextName,
          // The operator typed this one.
          titleSource: "explicit",
        }),
      }));
      setRetainedUnreadThread((current) =>
        current
        && threadSummaryIdentityKey(current) === threadSummaryIdentityKey(thread)
          ? {
              ...current,
              title: nextName,
              titleSource: "explicit",
            }
          : current
      );
      setOptimisticThread((current) =>
        current
        && threadSummaryIdentityKey(current) === threadSummaryIdentityKey(thread)
          ? {
              ...current,
              title: nextName,
              titleSource: "explicit",
            }
          : current
      );

      try {
        const federationTarget = thread.federation?.ref.target ??
          readRendererFederationTarget();
        await renameThreadRequest({
          backend: thread.source,
          ...(federationTarget ? { federationTarget } : {}),
          threadId: thread.id,
          name: nextName,
        });
        await refresh(threadKey);
      } catch (error) {
        setRenameThreadError(error instanceof Error ? error.message : String(error));
        await refresh(threadKey);
      }
    },
    [refresh, renameThreadRequest]
  );

  const setThreadReactionRequest = desktopApi?.setThreadReaction;
  const setThreadPinRequest = desktopApi?.setThreadPin;
  const setRemoteThreadLocalPinRequest = desktopApi?.setRemoteThreadLocalPin;
  const setThreadAgentRequest = desktopApi?.setThreadAgent;
  const reorderThreadPinsRequest = desktopApi?.reorderThreadPins;
  const setThreadParentRequest = desktopApi?.setThreadParent;
  const updateSubthreadOrderRequest = desktopApi?.updateSubthreadOrder;
  const setSubthreadsCollapsedRequest = desktopApi?.setSubthreadsCollapsed;
  const setDirectoryPinRequest = desktopApi?.setDirectoryPin;
  const reorderDirectoryPinsRequest = desktopApi?.reorderDirectoryPins;
  const setDirectoryThreadsCollapsedRequest =
    desktopApi?.setDirectoryThreadsCollapsed;
  const setThreadReaction = useCallback(
    async (
      thread: NavigationThreadSummary,
      emoji: string,
      present: boolean,
    ): Promise<void> => {
      if (!setThreadReactionRequest) {
        return;
      }

      // Optimistic update so the chip appears/disappears instantly.
      const currentReactions = thread.reactions ?? [];
      const optimisticReactions = present
        ? [...currentReactions.filter((existing) => existing !== emoji), emoji]
        : currentReactions.filter((existing) => existing !== emoji);
      setState((current) => ({
        ...current,
        rows: updateThreadReactionsInLoadedRows(current.rows, {
          backend: thread.source,
          federationTarget: thread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: thread.id,
          reactions: optimisticReactions,
        }),
      }));

      try {
        const result = await setThreadReactionRequest({
          backend: thread.source,
          federationTarget: thread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: thread.id,
          emoji,
          present,
        });
        // Reconcile with the authoritative server response (handles races).
        setState((current) => ({
          ...current,
          rows: updateThreadReactionsInLoadedRows(current.rows, {
            backend: thread.source,
            federationTarget: thread.federation?.ref.target ??
              readRendererFederationTarget(),
            threadId: thread.id,
            reactions: result.reactions,
          }),
        }));
      } catch {
        // On failure, fall back to the next snapshot poll.
      }
    },
    [setThreadReactionRequest],
  );

  const setThreadPin = useCallback(
    async (
      thread: NavigationThreadSummary,
      pinned: boolean,
    ): Promise<void> => {
      if (!setThreadPinRequest) {
        return;
      }

      const pinnedRank = pinned ? thread.pinnedRank : undefined;
      const federationTarget = thread.federation?.ref.target
        ?? readRendererFederationTarget();

      setState((current) => ({
        ...current,
        rows: updateThreadPinInLoadedRows(current.rows, {
          backend: thread.source,
          federationTarget,
          threadId: thread.id,
          pinnedRank,
        }),
      }));

      try {
        // A remote row pinned in the MAIN window takes a VIEWER-owned rank
        // on its remote_thread_pins row — only the viewer knows. In a
        // remote-viewer window (window-level target set) the row pins on
        // its owning instance as before: without that target the write
        // would land in the viewer machine's overlay store and revert on
        // the next remote snapshot.
        if (
          thread.federation
          && !readRendererFederationTarget()
          && setRemoteThreadLocalPinRequest
        ) {
          const result = await setRemoteThreadLocalPinRequest({
            ref: thread.federation.ref,
            pinned,
          });
          setState((current) => ({
            ...current,
            rows: updateThreadPinInLoadedRows(current.rows, {
              backend: thread.source,
              federationTarget,
              threadId: thread.id,
              pinnedRank: result.pinnedRank,
            }),
          }));
          return;
        }
        const result = await setThreadPinRequest({
          backend: thread.source,
          federationTarget,
          threadId: thread.id,
          pinned,
        });
        setState((current) => ({
          ...current,
          rows: updateThreadPinInLoadedRows(current.rows, {
            backend: result.backend,
            federationTarget,
            threadId: result.threadId,
            pinnedRank: result.pinnedRank,
          }),
        }));
      } catch {
        await refresh(threadSummaryIdentityKey(thread));
      }
    },
    [
      refresh,
      setRemoteThreadLocalPinRequest,
      setThreadPinRequest,
    ],
  );

  const reorderThreadPins = useCallback(
    async (orderedThreadKeys: string[], move?: NavigationRelativePinMove): Promise<void> => {
      if (!reorderThreadPinsRequest) {
        return;
      }

      const pinnedRanksByThreadKey = move ? {} : buildPinnedRanks(orderedThreadKeys);
      setState((current) => ({
        ...current,
        rows: updateThreadPinsInLoadedRows(current.rows, {
          pinnedRanksByThreadKey,
        }),
      }));

      try {
        const result = await reorderThreadPinsRequest({
          // A federation window reorders the owning instance's pins.
          federationTarget: readRendererFederationTarget(),
          ...(move ? { move } : { threadKeys: orderedThreadKeys }),
        });
        setState((current) => ({
          ...current,
          rows: updateThreadPinsInLoadedRows(current.rows, {
            pinnedRanksByThreadKey: result.pinnedRanks,
          }),
        }));
      } catch {
        await refresh();
      }
    },
    [refresh, reorderThreadPinsRequest],
  );

  const setThreadParent = useCallback(
    async (
      thread: NavigationThreadSummary,
      parentThreadId?: string,
      parentThreadBackend?: AppServerBackendKind,
    ): Promise<void> => {
      if (!setThreadParentRequest) {
        return;
      }
      const federationTarget = thread.federation?.ref.target
        ?? readRendererFederationTarget();

      setState((current) => ({
        ...current,
        rows: updateThreadParentInLoadedRows(current.rows, {
          backend: thread.source,
          federationTarget,
          threadId: thread.id,
          parentThreadId,
          parentThreadBackend,
        }),
      }));

      try {
        const result = await setThreadParentRequest({
          backend: thread.source,
          federationTarget,
          threadId: thread.id,
          parentThreadId,
          parentThreadBackend,
        });
        setState((current) => ({
          ...current,
          rows: updateThreadParentInLoadedRows(current.rows, {
            backend: result.backend,
            federationTarget,
            threadId: result.threadId,
            parentThreadId: result.parentThreadId,
            parentThreadBackend: result.parentThreadBackend,
            parentThreadInstanceId: result.parentThreadInstanceId,
          }),
        }));
      } catch {
        await refresh(threadSummaryIdentityKey(thread));
      }
    },
    [refresh, setThreadParentRequest],
  );

  const unlinkThreads = useCallback(
    async (threadsToUnlink: NavigationThreadSummary[]): Promise<void> => {
      if (!setThreadParentRequest || threadsToUnlink.length === 0) {
        return;
      }
      const snapshot = stateRef.current.rows;
      if (!snapshot) {
        return;
      }
      const threadByKey = new Map(
        loadedThreadRows(snapshot).map((thread) => [
          threadSummaryIdentityKey(thread),
          thread,
        ]),
      );
      const childKeysByPinnedParent = new Map<string, string[]>();
      for (const thread of threadsToUnlink) {
        const parentKey = resolveThreadParentKey(thread, threadByKey);
        const parent = parentKey ? threadByKey.get(parentKey) : undefined;
        if (!parentKey || !parent?.pinnedRank) {
          continue;
        }
        const childKeys = childKeysByPinnedParent.get(parentKey) ?? [];
        childKeys.push(threadSummaryIdentityKey(thread));
        childKeysByPinnedParent.set(parentKey, childKeys);
      }
      for (const [parentKey, childKeys] of childKeysByPinnedParent) {
        const parent = threadByKey.get(parentKey);
        const selectedChildren = childKeys
          .map((threadKey) => threadByKey.get(threadKey))
          .filter(
            (thread): thread is NavigationThreadSummary => Boolean(thread),
          );
        if (parent) {
          childKeysByPinnedParent.set(
            parentKey,
            sortSubthreadSummaries(parent, selectedChildren).map((thread) =>
              threadSummaryIdentityKey(thread)
            ),
          );
        }
      }
      const selectedKeys = new Set(
        threadsToUnlink.map((thread) =>
          threadSummaryIdentityKey(thread)
        ),
      );
      const currentPinnedKeys = loadedThreadRows(snapshot)
        .filter((thread) => thread.pinnedRank && !selectedKeys.has(
          threadSummaryIdentityKey(thread),
        ))
        .sort(comparePinnedThreads)
        .map((thread) => threadSummaryIdentityKey(thread));
      const nextPinnedKeys = currentPinnedKeys.flatMap((threadKey) => [
        ...(childKeysByPinnedParent.get(threadKey) ?? []),
        threadKey,
      ]);
      const pinnedRanksByThreadKey = buildPinnedRanks(nextPinnedKeys);

      setState((current) => ({
        ...current,
        rows: updateThreadPinsInLoadedRows(
          threadsToUnlink.reduce(
            (response, thread) => updateThreadParentInLoadedRows(response, {
              backend: thread.source,
              federationTarget: thread.federation?.ref.target
                ?? readRendererFederationTarget(),
              threadId: thread.id,
              parentThreadId: undefined,
            }),
            current.rows,
          ),
          { pinnedRanksByThreadKey },
        ),
      }));

      const successfullyUnlinkedPinnedKeys = new Set<string>();
      for (const thread of threadsToUnlink) {
        try {
          if (
            thread.federation?.derivedFromMountedParent
            && !readRendererFederationTarget()
          ) {
            if (!desktopApi?.addRemoteThreadPin) {
              throw new Error(
                "Desktop bridge cannot preserve this derived remote child.",
              );
            }
            // Derived children ride along with a mounted parent and have no
            // viewer-side pin row of their own. Persist one before clearing the
            // owner relationship or the next refresh would drop the child.
            await desktopApi.addRemoteThreadPin({
              ref: thread.federation.ref,
              instanceLabel: thread.federation.instanceLabel,
              summary: thread,
            });
          }
          await setThreadParentRequest({
            backend: thread.source,
            federationTarget: thread.federation?.ref.target ??
              readRendererFederationTarget(),
            threadId: thread.id,
          });
          const threadKey = threadSummaryIdentityKey(thread);
          const parentKey = resolveThreadParentKey(thread, threadByKey);
          if (parentKey && childKeysByPinnedParent.has(parentKey)) {
            successfullyUnlinkedPinnedKeys.add(threadKey);
          }
        } catch (error) {
          console.warn(`Could not unlink thread ${thread.id}:`, error);
        }
      }
      const nextSuccessfulPinnedKeys = currentPinnedKeys.flatMap(
        (threadKey) => [
          ...(childKeysByPinnedParent.get(threadKey) ?? []).filter(
            (childKey) => successfullyUnlinkedPinnedKeys.has(childKey),
          ),
          threadKey,
        ],
      );
      try {
        if (
          successfullyUnlinkedPinnedKeys.size > 0
          && reorderThreadPinsRequest
        ) {
          await reorderThreadPinsRequest({
            federationTarget: readRendererFederationTarget(),
            threadKeys: nextSuccessfulPinnedKeys,
          });
        }
      } catch (error) {
        console.warn("Could not pin the unlinked threads above their parent:", error);
      }
      await refresh();
    },
    [desktopApi, refresh, reorderThreadPinsRequest, setThreadParentRequest],
  );

  const updateSubthreadOrder = useCallback(
    async (
      parent: NavigationThreadSummary,
      threadIds: string[],
    ): Promise<void> => {
      if (
        !updateSubthreadOrderRequest
        || !threadSupportsFederationCapability(parent, "thread_grouping")
      ) {
        return;
      }
      const federationTarget = parent.federation?.ref.target
        ?? readRendererFederationTarget();

      setState((current) => ({
        ...current,
        rows: updateSubthreadOrderInLoadedRows(current.rows, {
          backend: parent.source,
          federationTarget,
          parentThreadId: parent.id,
          threadIds,
        }),
      }));

      try {
        const result = await updateSubthreadOrderRequest({
          backend: parent.source,
          federationTarget,
          parentThreadId: parent.id,
          threadIds,
        });
        setState((current) => ({
          ...current,
          rows: updateSubthreadOrderInLoadedRows(current.rows, {
            backend: result.backend,
            federationTarget,
            parentThreadId: result.parentThreadId,
            threadIds: result.threadIds,
          }),
        }));
      } catch {
        await refresh(threadSummaryIdentityKey(parent));
      }
    },
    [refresh, updateSubthreadOrderRequest],
  );

  const setSubthreadsCollapsed = useCallback(
    async (
      parent: NavigationThreadSummary,
      collapsed: boolean,
    ): Promise<void> => {
      if (
        !setSubthreadsCollapsedRequest
        || !threadSupportsFederationCapability(parent, "thread_grouping")
      ) {
        return;
      }
      const federationTarget = parent.federation?.ref.target
        ?? readRendererFederationTarget();

      setState((current) => ({
        ...current,
        rows: updateSubthreadsCollapsedInLoadedRows(current.rows, {
          backend: parent.source,
          federationTarget,
          parentThreadId: parent.id,
          collapsed,
        }),
      }));

      try {
        const result = await setSubthreadsCollapsedRequest({
          backend: parent.source,
          federationTarget,
          parentThreadId: parent.id,
          collapsed,
        });
        setState((current) => ({
          ...current,
          rows: updateSubthreadsCollapsedInLoadedRows(current.rows, {
            backend: result.backend,
            federationTarget,
            parentThreadId: result.parentThreadId,
            collapsed: result.collapsed,
          }),
        }));
      } catch {
        await refresh(threadSummaryIdentityKey(parent));
      }
    },
    [refresh, setSubthreadsCollapsedRequest],
  );

  const setThreadAgent = useCallback(
    async (
      thread: NavigationThreadSummary,
      agent: Parameters<NonNullable<DesktopApi["setThreadAgent"]>>[0]["agent"],
    ): Promise<void> => {
      if (!setThreadAgentRequest) {
        return;
      }

      try {
        const result = await setThreadAgentRequest({
          backend: thread.source,
          threadId: thread.id,
          agent,
        });
        setState((current) => ({
          ...current,
          rows: updateThreadAgentInLoadedRows(current.rows, {
            backend: result.backend,
            threadId: result.threadId,
            agent: result.agent,
          }),
        }));
      } catch {
        await refresh(threadSummaryIdentityKey(thread));
      }
    },
    [refresh, setThreadAgentRequest],
  );

  /**
   * Directory pin mutators (plan 2026-05-09-002, Unit J). Mirror of
   * setThreadPin / reorderThreadPins — optimistic snapshot patch,
   * IPC call, re-patch with authoritative response, refresh() on
   * throw. The patcher short-circuits when the optimistic rank
   * matches the response so the second patch is a no-op (no
   * double-render).
   */
  const setDirectoryPin = useCallback(
    async (
      directory: NavigationDirectorySummary,
      pinned: boolean,
    ): Promise<void> => {
      if (!setDirectoryPinRequest) {
        return;
      }

      const pinnedRank = pinned ? directory.pinnedRank : undefined;

      setState((current) => ({
        ...current,
        rows: updateDirectoryPinInLoadedRows(current.rows, {
          directoryKey: directory.key,
          pinnedRank,
        }),
      }));

      try {
        const result = await setDirectoryPinRequest({
          directoryKey: directory.key,
          pinned,
        });
        setState((current) => ({
          ...current,
          rows: updateDirectoryPinInLoadedRows(current.rows, {
            directoryKey: result.directoryKey,
            pinnedRank: result.pinnedRank,
          }),
        }));
      } catch {
        await refresh();
      }
    },
    [refresh, setDirectoryPinRequest],
  );

  const reorderDirectoryPins = useCallback(
    async (directoryKeys: string[], move?: NavigationRelativePinMove): Promise<void> => {
      if (!reorderDirectoryPinsRequest) {
        return;
      }

      const pinnedRanks = move ? {} : buildPinnedRanks(directoryKeys);
      setState((current) => ({
        ...current,
        rows: updateDirectoryPinsInLoadedRows(current.rows, {
          pinnedRanks,
        }),
      }));

      try {
        const result = await reorderDirectoryPinsRequest(move ? { move } : { directoryKeys });
        setState((current) => ({
          ...current,
          rows: updateDirectoryPinsInLoadedRows(current.rows, {
            pinnedRanks: result.pinnedRanks,
          }),
        }));
      } catch {
        await refresh();
      }
    },
    [refresh, reorderDirectoryPinsRequest],
  );

  const setDirectoryThreadsCollapsed = useCallback(
    async (
      directory: NavigationDirectorySummary,
      collapsed: boolean,
    ): Promise<void> => {
      if (!setDirectoryThreadsCollapsedRequest) {
        return;
      }

      const federationTarget = readRendererFederationTarget();
      if (federationTarget && isRemoteFederationTarget(federationTarget)) {
        remoteDirectoryThreadsCollapsedOverridesRef.current.set(
          directory.key,
          collapsed,
        );
      }

      setState((current) => ({
        ...current,
        rows: updateDirectoryThreadsCollapsedInLoadedRows(
          current.rows,
          {
            directoryKey: directory.key,
            collapsed,
          },
        ),
      }));

      try {
        const result = await setDirectoryThreadsCollapsedRequest({
          directoryKey: directory.key,
          collapsed,
          ...(federationTarget ? { federationTarget } : {}),
        });
        setState((current) => ({
          ...current,
          rows: updateDirectoryThreadsCollapsedInLoadedRows(
            current.rows,
            {
              directoryKey: result.directoryKey,
              collapsed: result.collapsed,
            },
          ),
        }));
      } catch {
        if (federationTarget && isRemoteFederationTarget(federationTarget)) {
          remoteDirectoryThreadsCollapsedOverridesRef.current.delete(
            directory.key,
          );
        }
        await refresh();
      }
    },
    [refresh, setDirectoryThreadsCollapsedRequest],
  );

  const updateThreadExecutionMode = useCallback(
    async (
      thread: NavigationThreadSummary,
      executionMode: ThreadExecutionMode
    ): Promise<void> => {
      if (!setThreadExecutionMode) {
        setSetThreadExecutionModeError(
          "Desktop bridge is missing setThreadExecutionMode()."
        );
        return;
      }

      setUpdatingThreadExecutionMode(executionMode);
      setSetThreadExecutionModeError(undefined);
      // No optimistic flip of `executionMode` here. Two cases:
      //
      // 1. Thread is idle → registry applies immediately. The
      //    `thread/executionMode/updated` bus event arrives within a
      //    network round-trip (~50ms locally) and drives the visible
      //    state via `applyThreadExecutionModeUpdate`.
      //
      // 2. Thread has an active turn → registry queues the change.
      //    The `thread/executionMode/queued` bus event arrives and
      //    sets `queuedExecutionMode` on the snapshot, leaving
      //    `executionMode` at its applied value. The Composer
      //    queue-indicator block renders because
      //    `queuedExecutionMode !== executionMode`.
      //
      // An optimistic flip of `executionMode` here would break case
      // (2): the queue would arrive with `queuedExecutionMode` equal
      // to the optimistic value (and equal to `executionMode`), so
      // the indicator would never render — the user would see the
      // chip flip and assume the change took effect immediately.
      // The `setUpdatingThreadExecutionMode(executionMode)` indicator
      // above gives users a "click registered" signal during the
      // round-trip without lying about applied state.

      try {
        thread = await readNavigationActionThread({ api: desktopApi, thread, target: readRendererFederationTarget(), signal: actionAbortControllerRef.current.signal });
        await setThreadExecutionMode({
          backend: thread.source,
          federationTarget: thread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: thread.id,
          executionMode,
        });
        await refresh(threadSummaryIdentityKey(thread));
      } catch (error) {
        setSetThreadExecutionModeError(error instanceof Error ? error.message : String(error));
        await refresh(threadSummaryIdentityKey(thread));
      } finally {
        setUpdatingThreadExecutionMode(undefined);
      }
    },
    [desktopApi, refresh, setThreadExecutionMode]
  );

  const cancelThreadExecutionModeQueue = useCallback(
    async (thread: NavigationThreadSummary): Promise<void> => {
      if (!cancelThreadExecutionModeQueueRequest) {
        setSetThreadExecutionModeError(
          "Desktop bridge is missing cancelThreadExecutionModeQueue()."
        );
        return;
      }
      setSetThreadExecutionModeError(undefined);
      try {
        await cancelThreadExecutionModeQueueRequest({
          backend: thread.source,
          federationTarget: thread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: thread.id,
        });
        await refresh(threadSummaryIdentityKey(thread));
      } catch (error) {
        setSetThreadExecutionModeError(
          error instanceof Error ? error.message : String(error)
        );
        await refresh(threadSummaryIdentityKey(thread));
      }
    },
    [cancelThreadExecutionModeQueueRequest, refresh]
  );

  const updateThreadModelSettings = useCallback(
    async (
      thread: NavigationThreadSummary,
      patch: Partial<
        Pick<
          NavigationThreadSummary,
          "model" | "reasoningEffort" | "serviceTier" | "fastMode"
        >
      >
    ): Promise<void> => {
      if (!setThreadModelSettings) {
        setSetThreadModelSettingsError(
          "Desktop bridge is missing setThreadModelSettings()."
        );
        return;
      }

      try {
        thread = await readNavigationActionThread({ api: desktopApi, thread: thread, target: readRendererFederationTarget() });
      } catch (error) {
        setSetThreadModelSettingsError(error instanceof Error ? error.message : String(error));
        return;
      }

      const nextSettings = {
        ...("model" in patch
          ? { model: patch.model }
          : thread.model
            ? { model: thread.model }
            : {}),
        ...("reasoningEffort" in patch
          ? { reasoningEffort: patch.reasoningEffort }
          : {}),
        ...("serviceTier" in patch ? { serviceTier: patch.serviceTier } : {}),
        ...(thread.source === "codex" && "fastMode" in patch
          ? { fastMode: patch.fastMode }
          : {}),
      };

      setSetThreadModelSettingsError(undefined);
      setOptimisticThread((current) =>
        current && current.id === thread.id && current.source === thread.source
          ? { ...current, ...nextSettings }
          : current
      );
      setState((current) => ({
        ...current,
        rows: applyThreadModelSettingsUpdate(current.rows, {
          backend: thread.source,
          threadId: thread.id,
          ...nextSettings,
        }),
      }));

      try {
        await setThreadModelSettings({
          backend: thread.source,
          federationTarget: thread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: thread.id,
          ...nextSettings,
        });
      } catch (error) {
        setSetThreadModelSettingsError(
          error instanceof Error ? error.message : String(error)
        );
        await refresh(threadSummaryIdentityKey(thread));
      }
    },
    [
      desktopApi,refresh, setThreadModelSettings]
  );

  const updateThreadPrAutoDispatch = useCallback(
    async (
      thread: NavigationThreadSummary,
      enabled: boolean,
    ): Promise<void> => {
      if (!setThreadPrAutoDispatchRequest) {
        setSetThreadModelSettingsError(
          "Desktop bridge is missing setThreadPrAutoDispatch().",
        );
        return;
      }
      setSetThreadModelSettingsError(undefined);
      setOptimisticThread((current) =>
        current
        && threadSummaryIdentityKey(current) === threadSummaryIdentityKey(thread)
          ? { ...current, prAutoDispatchEnabled: enabled }
          : current
      );
      setState((current) => ({
        ...current,
        rows: applyThreadPrAutoDispatchUpdate(current.rows, {
          backend: thread.source,
          federationTarget: thread.federation?.ref.target,
          threadId: thread.id,
          enabled,
        }),
      }));

      try {
        await setThreadPrAutoDispatchRequest({
          backend: thread.source,
          // Remote threads toggle Auto-fix on their owning instance; the
          // owner's thread/prAutoDispatch/updated event converges viewers.
          federationTarget: thread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: thread.id,
          enabled,
        });
      } catch (error) {
        setSetThreadModelSettingsError(
          error instanceof Error ? error.message : String(error),
        );
        await refresh(threadSummaryIdentityKey(thread));
      }
    },
    [refresh, setThreadPrAutoDispatchRequest],
  );

  const cancelPendingThreadPrAutoDispatch = useCallback(
    async (
      thread: NavigationThreadSummary,
      fingerprint: string,
    ): Promise<void> => {
      if (!cancelThreadPrAutoDispatchRequest) return;
      await cancelThreadPrAutoDispatchRequest({
        backend: thread.source,
        // The pending dispatch lives in the owning instance's
        // coordinator, so the cancel has to travel there.
        federationTarget: thread.federation?.ref.target ??
          readRendererFederationTarget(),
        threadId: thread.id,
        fingerprint,
      });
    },
    [cancelThreadPrAutoDispatchRequest],
  );

  const sendPendingThreadPrAutoDispatchNow = useCallback(
    async (
      thread: NavigationThreadSummary,
      fingerprint: string,
    ): Promise<void> => {
      if (!sendThreadPrAutoDispatchNowRequest) return;
      await sendThreadPrAutoDispatchNowRequest({
        backend: thread.source,
        // Promoting the scheduled turn only works on the owner, which is
        // where the pending dispatch was armed.
        federationTarget: thread.federation?.ref.target ??
          readRendererFederationTarget(),
        threadId: thread.id,
        fingerprint,
      });
    },
    [sendThreadPrAutoDispatchNowRequest],
  );

  const updateAcpSessionRuntimeOption = useCallback(
    async (
      thread: NavigationThreadSummary,
      params: {
        source: "configOption" | "mode";
        optionId: string;
        value: string;
      }
    ): Promise<void> => {
      if (!setAcpSessionRuntimeOption) {
        setSetThreadExecutionModeError(
          "Desktop bridge is missing setAcpSessionRuntimeOption()."
        );
        return;
      }

      setSetThreadExecutionModeError(undefined);
      try {
        thread = await readNavigationActionThread({ api: desktopApi, thread, target: readRendererFederationTarget(), signal: actionAbortControllerRef.current.signal });
      } catch (error) {
        setSetThreadExecutionModeError(error instanceof Error ? error.message : String(error));
        return;
      }
      const nextAcpRuntime: NavigationThreadSummary["acpRuntime"] = {
        ...thread.acpRuntime,
        configValues:
          params.source === "configOption"
            ? {
                ...(thread.acpRuntime?.configValues ?? {}),
                [params.optionId]: params.value,
              }
            : thread.acpRuntime?.configValues,
        currentModeId:
          params.source === "mode" || params.source === "configOption"
            ? params.value
            : thread.acpRuntime?.currentModeId,
        updatedAt: Date.now(),
      };
      setOptimisticThread((current) =>
        current && current.id === thread.id && current.source === thread.source
          ? { ...current, acpRuntime: nextAcpRuntime }
          : current
      );
      setState((current) => ({
        ...current,
        rows: applyThreadAcpRuntimeUpdate(current.rows, {
          backend: thread.source,
          threadId: thread.id,
          acpRuntime: nextAcpRuntime,
        }),
      }));
      try {
        await setAcpSessionRuntimeOption({
          backend: thread.source,
          federationTarget: thread.federation?.ref.target ??
            readRendererFederationTarget(),
          threadId: thread.id,
          ...params,
        });
        await refresh(threadSummaryIdentityKey(thread));
      } catch (error) {
        setSetThreadExecutionModeError(
          error instanceof Error ? error.message : String(error)
        );
        await refresh(threadSummaryIdentityKey(thread));
      }
    },
    [desktopApi, refresh, setAcpSessionRuntimeOption]
  );

  const dismissArchiveThreadNotice = useCallback((): void => {
    setArchiveThreadNotice(undefined);
  }, []);

  return {
    browseMode,
    directoryDisclosure,
    composerSourceThreadKey,
    createThread,
    createSubthread,
    discardLaunchpad,
    forkThread,
    creatingThread,
    directories,
    error: state.error,
    federationTarget:
      activeFederatedLaunchpad?.target ?? state.rows?.federationTarget,
    inboxThreads,
    recentThreads,
    launchpadError,
    pendingLaunchpadCreations,
    archiveThreadNotice,
    dismissArchiveThreadNotice,
    worktreeArchiveError,
    loading: state.loading,
    loaded: Boolean(state.rows),
    providerRefresh: boundedNavigation.resources.get("directory-index")?.state.page?.coverage
      ? { ...boundedNavigation.resources.get("directory-index")!.state.page!.coverage, state: boundedNavigation.resources.get("directory-index")!.state.page!.coverage.state === "complete" ? "ready" : boundedNavigation.resources.get("directory-index")!.state.page!.coverage.state as "checking" | "degraded" } : undefined,
    refreshing: state.refreshing,
    refresh: refreshNavigation,
    materializeDirectoryLaunchpad,
    newThreadDirectoryLabel,
    launchpadDirectories,
    openDirectoryLaunchpad,
    openFederatedDirectoryLaunchpad,
    openWorkspaceLaunchpad,
    openFederatedWorkspaceLaunchpad,
    pickAndRegisterDirectory,
    addProjectDirectory,
    pickAndAttachDirectoryToSelectedThread,
    pickDirectoryForReference,
    attachDirectoryPathsToThread,
    pickDirectoryError,
    pickingDirectory,
    clearPickDirectoryError,
    resetDirectoryLaunchpad,
    removeDirectory,
    markDirectoriesSeen,
    selectDirectoryLaunchpad,
    selectPendingLaunchpad,
    selectedDirectory,
    selectedItemKey: displaySelectionKey,
    selectedLaunchpad,
    selectedThread,
    selectedThreadConfigurationReady,
    selectedThreadConfigurationError: selectedDetail.state?.error
      ?? (selectedDetail.state?.detail && selectedDetail.state.detail.identity !== "present"
        ? `This thread is ${selectedDetail.state.detail.identity}.` : undefined),
    refreshSelectedThreadConfiguration: selectedDetail.refresh,
    selectedThreadKey,
    setThreadExecutionMode: updateThreadExecutionMode,
    setAcpSessionRuntimeOption: updateAcpSessionRuntimeOption,
    setThreadExecutionModeError,
    cancelThreadExecutionModeQueue,
    setThreadModelSettings: updateThreadModelSettings,
    setThreadPrAutoDispatch: updateThreadPrAutoDispatch,
    cancelThreadPrAutoDispatch: cancelPendingThreadPrAutoDispatch,
    sendThreadPrAutoDispatchNow: sendPendingThreadPrAutoDispatchNow,
    setThreadModelSettingsError,
    updatingThreadExecutionMode,
    updateDirectoryLaunchpad,
    setBrowseMode: updateBrowseMode,
    selectThread,
    markThreadsSeen,
    markThreadUnread,
    showThread,
    archiveThread,
    archiveWorktree,
    restoreWorktree,
    handoffThreadWorkspace,
    renameThread,
    setThreadReaction,
    setThreadPin,
    setThreadAgent,
    reorderThreadPins,
    setThreadParent,
    unlinkThreads,
    updateSubthreadOrder,
    setSubthreadsCollapsed,
    setDirectoryPin,
    reorderDirectoryPins,
    setDirectoryThreadsCollapsed,
    loadedRows: state.rows,
    pagedNavigation: boundedNavigation,
    selectedLaunchpadConfigurationReady: Boolean(activeFederatedLaunchpad) || launchpadConfiguration.ready,
    threads,
  };
}
