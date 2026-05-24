import type {
  DirectoryLaunchpadOverlayState,
  DirectoryOverlayState,
  CodexEnvironmentOption,
  AutomationThreadSummary,
  NavigationDirectoryGitStatus,
  AppServerBackendScope,
  AppServerThreadSummary,
  LinkedDirectorySummary,
  MessagingThreadBindingSummary,
  NavigationSnapshot,
  NavigationThreadSummary,
  NavigationLaunchpadDefaults,
  ThreadOverlayState,
} from "@pwragent/shared";
import { buildThreadIdentityKey, isToolManagedWorktreePath } from "@pwragent/shared";
import { deriveInboxState, rankInboxThreadKeys } from "./inbox";
import { buildDirectorySummaries } from "./directory-navigation";

type AppServerThreadSummaryWithEnvironmentOptions = AppServerThreadSummary & {
  codexEnvironmentOptions?: CodexEnvironmentOption[];
};

/** Check whether a linked directory was created by the handoff service. */
function isHandoffDirectory(directory: LinkedDirectorySummary): boolean {
  return (
    directory.id.startsWith("pwragent-handoff:") ||
    directory.id.startsWith("pwragnt-handoff:")  // legacy prefix from pre-rebrand data
  );
}

function dedupeLinkedDirectories(
  directories: LinkedDirectorySummary[],
): LinkedDirectorySummary[] {
  const normalizedDirectories = directories.map(normalizeLinkedDirectoryKind);
  let overlayWorkspace: LinkedDirectorySummary | undefined;
  for (const directory of normalizedDirectories) {
    if (isHandoffDirectory(directory)) {
      overlayWorkspace = directory;
    }
  }
  const filteredDirectories = overlayWorkspace
    ? normalizedDirectories.filter(
        (directory) =>
          directory.id === overlayWorkspace.id ||
          (directory.kind !== "local" && directory.kind !== "worktree"),
      )
    : normalizedDirectories;
  const byId = new Map<string, LinkedDirectorySummary>();

  for (const directory of filteredDirectories) {
    byId.set(directory.id, directory);
  }

  return [...byId.values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

function normalizeLinkedDirectoryKind(
  directory: LinkedDirectorySummary,
): LinkedDirectorySummary {
  if (
    directory.kind === "local" &&
    (directory.worktreePath?.trim() || isToolManagedWorktreePath(directory.path))
  ) {
    const worktreePath = directory.worktreePath?.trim() || directory.path;
    return {
      ...directory,
      kind: "worktree",
      worktreePath,
    };
  }

  return directory;
}

function hasHandoffWorkspace(directories: LinkedDirectorySummary[]): boolean {
  return directories.map(normalizeLinkedDirectoryKind).some(isHandoffDirectory);
}

function resolveNavigationGitBranch(params: {
  overlay?: ThreadOverlayState;
  thread: AppServerThreadSummary;
}): string | undefined {
  const overlayBranch = params.overlay?.gitBranch?.trim();
  if (overlayBranch) {
    return overlayBranch;
  }

  const overlayObservedBranch = params.overlay?.observedGitBranch?.trim();
  const threadObservedBranch = params.thread.observedGitBranch?.trim();
  if (
    overlayObservedBranch &&
    threadObservedBranch &&
    overlayObservedBranch !== threadObservedBranch
  ) {
    return overlayObservedBranch;
  }

  if (
    overlayObservedBranch &&
    hasHandoffWorkspace(params.overlay?.extraLinkedDirectories ?? [])
  ) {
    return overlayObservedBranch;
  }

  return params.thread.gitBranch;
}

function resolveNavigationObservedBranch(params: {
  overlay?: ThreadOverlayState;
  thread: AppServerThreadSummary;
}): string | undefined {
  const overlayBranch = params.overlay?.gitBranch?.trim();
  const overlayObservedBranch = params.overlay?.observedGitBranch?.trim();

  if (overlayBranch && overlayObservedBranch) {
    return overlayObservedBranch;
  }

  return params.thread.observedGitBranch ?? params.overlay?.observedGitBranch;
}

export function materializeNavigationThreads(params: {
  firstSnapshot: boolean;
  now?: number;
  overlayByThreadKey: Record<string, ThreadOverlayState | undefined>;
  /**
   * Active messaging bindings per thread, keyed by thread identity key.
   * Sourced from the desktop's messaging store (sqlite). When omitted,
   * threads have no `messagingBindings` field — non-desktop callers
   * (tests, server-side use) don't need to wire it.
   */
  messagingBindingsByThreadKey?: Record<string, MessagingThreadBindingSummary[] | undefined>;
  automationsByThreadKey?: Record<string, AutomationThreadSummary | undefined>;
  previousKnownThreadKeys: string[];
  threads: AppServerThreadSummaryWithEnvironmentOptions[];
}): NavigationThreadSummary[] {
  const previousKnownThreadKeys = new Set(params.previousKnownThreadKeys);

  return params.threads.map((thread) => {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);
    const overlay = params.overlayByThreadKey[threadKey];
    const linkedDirectories = dedupeLinkedDirectories([
      ...thread.linkedDirectories,
      ...(overlay?.extraLinkedDirectories ?? []),
    ]);
    const gitBranch = resolveNavigationGitBranch({ overlay, thread });
    const observedGitBranch = resolveNavigationObservedBranch({ overlay, thread });
    const messagingBindings = params.messagingBindingsByThreadKey?.[threadKey];
    const automationSummary = params.automationsByThreadKey?.[threadKey];

    return {
      ...thread,
      agent: overlay?.agent,
      gitBranch,
      observedGitBranch,
      retainedBranchDriftPairs: overlay?.retainedBranchDriftPairs,
      executionMode: overlay?.executionMode ?? thread.executionMode ?? "default",
      queuedExecutionMode: overlay?.queuedExecutionMode,
      queuedExecutionModeAt: overlay?.queuedExecutionModeAt,
      permissionTransitionLog: overlay?.permissionTransitionLog,
      messagingBindingTransitionLog: overlay?.messagingBindingTransitionLog,
      model: overlay?.model ?? thread.model,
      reasoningEffort: overlay?.reasoningEffort ?? thread.reasoningEffort,
      serviceTier: overlay?.serviceTier ?? thread.serviceTier,
      fastMode: overlay?.fastMode ?? thread.fastMode,
      codexEnvironmentRuntime:
        overlay?.codexEnvironmentRuntime ?? thread.codexEnvironmentRuntime,
      codexEnvironmentOptions: thread.codexEnvironmentOptions,
      linkedDirectories,
      worktreeSnapshots: overlay?.worktreeSnapshots ?? thread.worktreeSnapshots ?? [],
      reactions: overlay?.reactions ?? [],
      pinnedRank: overlay?.pinnedRank,
      prs: overlay?.prs ?? [],
      messagingBindings: messagingBindings && messagingBindings.length > 0
        ? messagingBindings
        : undefined,
      automationSummary,
      inbox: deriveInboxState({
        firstSnapshot: params.firstSnapshot,
        isNewThread: !previousKnownThreadKeys.has(threadKey),
        now: params.now,
        overlay,
        thread,
      }),
    };
  });
}

export function buildNavigationSnapshot(params: {
  backend: AppServerBackendScope;
  fetchedAt: number;
  firstSnapshot: boolean;
  now?: number;
  gitStatusByDirectoryKey?: Record<string, NavigationDirectoryGitStatus | undefined>;
  launchpadDefaults?: NavigationLaunchpadDefaults;
  launchpadsByKey?: Record<string, DirectoryLaunchpadOverlayState | undefined>;
  /**
   * Per-directory overlay (currently `pinnedRank` only) — see
   * `buildDirectorySummaries` for the contract. Plumbed through here
   * so the caller (SqliteOverlayStore.reconcileNavigationSnapshot)
   * doesn't have to call the builder twice.
   */
  directoryOverlayByKey?: Record<string, DirectoryOverlayState | undefined>;
  messagingBindingsByThreadKey?: Record<string, MessagingThreadBindingSummary[] | undefined>;
  automationsByThreadKey?: Record<string, AutomationThreadSummary | undefined>;
  overlayByThreadKey: Record<string, ThreadOverlayState | undefined>;
  previousKnownThreadKeys: string[];
  threads: AppServerThreadSummaryWithEnvironmentOptions[];
  unchanged: boolean;
  workspaceRoots?: string[];
}): NavigationSnapshot {
  const threads = materializeNavigationThreads({
    firstSnapshot: params.firstSnapshot,
    now: params.now,
    overlayByThreadKey: params.overlayByThreadKey,
    messagingBindingsByThreadKey: params.messagingBindingsByThreadKey,
    automationsByThreadKey: params.automationsByThreadKey,
    previousKnownThreadKeys: params.previousKnownThreadKeys,
    threads: params.threads,
  });

  return {
    backend: params.backend,
    fetchedAt: params.fetchedAt,
    unchanged: params.unchanged,
    threads,
    inboxThreadKeys: rankInboxThreadKeys(threads),
    directories: buildDirectorySummaries({
      threads,
      launchpadsByKey: params.launchpadsByKey,
      gitStatusByKey: params.gitStatusByDirectoryKey,
      directoryOverlayByKey: params.directoryOverlayByKey,
      workspaceRoots: params.workspaceRoots,
    }),
    launchpadDefaults: params.launchpadDefaults ?? {
      backend: "codex",
      executionMode: "default",
    },
  };
}

export function buildNavigationSnapshotHash(params: {
  backend: AppServerBackendScope;
  directories?: NavigationSnapshot["directories"];
  launchpadDefaults?: NavigationLaunchpadDefaults;
  threads: NavigationThreadSummary[];
}): string {
  return JSON.stringify({
    backend: params.backend,
    threads: params.threads.map((thread) => ({
      source: thread.source,
      id: thread.id,
      title: thread.title,
      titleSource: thread.titleSource,
      agent: thread.agent
        ? {
            name: thread.agent.name,
            instructions: thread.agent.instructions ?? null,
            instructionLineCount: thread.agent.instructionLineCount,
            instructionsTooLong: thread.agent.instructionsTooLong,
            updatedAt: thread.agent.updatedAt,
          }
        : null,
      summary: thread.summary ?? null,
      projectKey: thread.projectKey ?? null,
      updatedAt: thread.updatedAt ?? null,
      gitBranch: thread.gitBranch ?? null,
      observedGitBranch: thread.observedGitBranch ?? null,
      retainedBranchDriftPairs: (thread.retainedBranchDriftPairs ?? []).map((pair) => ({
        expectedBranch: pair.expectedBranch,
        observedBranch: pair.observedBranch,
        retainedAt: pair.retainedAt,
      })),
      executionMode: thread.executionMode ?? "default",
      queuedExecutionMode: thread.queuedExecutionMode ?? null,
      queuedExecutionModeAt: thread.queuedExecutionModeAt ?? null,
      permissionTransitionLog: (thread.permissionTransitionLog ?? []).map(
        (entry) => ({
          id: entry.id,
          fromExecutionMode: entry.fromExecutionMode,
          toExecutionMode: entry.toExecutionMode,
          status: entry.status,
          occurredAt: entry.occurredAt,
          queueId: entry.queueId ?? null,
          note: entry.note ?? null,
        }),
      ),
      messagingBindingTransitionLog: (
        thread.messagingBindingTransitionLog ?? []
      ).map((entry) => ({
        id: entry.id,
        action: entry.action,
        bindingId: entry.bindingId,
        platform: entry.platform,
        conversationKind: entry.conversationKind ?? null,
        conversationTitle: entry.conversationTitle ?? null,
        parentTitle: entry.parentTitle ?? null,
        ancestorTitle: entry.ancestorTitle ?? null,
        occurredAt: entry.occurredAt,
      })),
      model: thread.model ?? null,
      reasoningEffort: thread.reasoningEffort ?? null,
      serviceTier: thread.serviceTier ?? null,
      fastMode: thread.fastMode ?? null,
      codexEnvironmentRuntime: thread.codexEnvironmentRuntime
        ? {
            environmentId: thread.codexEnvironmentRuntime.environmentId,
            environmentName: thread.codexEnvironmentRuntime.environmentName,
            executionTarget: thread.codexEnvironmentRuntime.executionTarget,
            cwd: thread.codexEnvironmentRuntime.cwd ?? null,
            setupEnabled: thread.codexEnvironmentRuntime.setupEnabled ?? null,
            setupStatus: thread.codexEnvironmentRuntime.setupStatus ?? null,
            setupCommand: thread.codexEnvironmentRuntime.setupCommand ?? null,
            setupOutput: thread.codexEnvironmentRuntime.setupOutput ?? null,
            setupExitCode: thread.codexEnvironmentRuntime.setupExitCode ?? null,
            setupDurationMs: thread.codexEnvironmentRuntime.setupDurationMs ?? null,
            actions: (thread.codexEnvironmentRuntime.actions ?? []).map(
              (action) => ({
                id: action.id,
                name: action.name,
                icon: action.icon ?? null,
                command: action.command,
              }),
            ),
            actionId: thread.codexEnvironmentRuntime.actionId ?? null,
            actionName: thread.codexEnvironmentRuntime.actionName ?? null,
            actionCommand: thread.codexEnvironmentRuntime.actionCommand ?? null,
            actionStatus: thread.codexEnvironmentRuntime.actionStatus ?? null,
            actionPid: thread.codexEnvironmentRuntime.actionPid ?? null,
            // Multi-instance env-action runs (PR #505). Each run's
            // identity + lifecycle fields contribute to the hash so the
            // navigation snapshot invalidates when any run starts, gets
            // a new output snapshot, or exits.
            actionRuns: (thread.codexEnvironmentRuntime.actionRuns ?? []).map(
              (run) => ({
                runId: run.runId,
                actionId: run.actionId,
                actionName: run.actionName,
                command: run.command,
                status: run.status,
                pid: run.pid ?? null,
                startedAt: run.startedAt,
                exitedAt: run.exitedAt ?? null,
                exitCode: run.exitCode ?? null,
                exitSignal: run.exitSignal ?? null,
                durationMs: run.durationMs ?? null,
                // Hash the output's length only — the actual bytes can
                // be megabytes and hashing them on every snapshot would
                // be wasteful. Length still flips the hash on each new
                // chunk's overlay write so live-output renders refresh.
                outputLength: run.output?.length ?? 0,
              }),
            ),
            sourcePath: thread.codexEnvironmentRuntime.sourcePath ?? null,
          }
        : null,
      codexEnvironmentOptions: (thread.codexEnvironmentOptions ?? []).map(
        (environment) => ({
          id: environment.id,
          name: environment.name,
          sourcePath: environment.sourcePath,
          setupScript: environment.setupScript ?? null,
          cleanupScript: environment.cleanupScript ?? null,
          actions: environment.actions.map((action) => ({
            id: action.id,
            name: action.name,
            icon: action.icon ?? null,
            command: action.command,
          })),
        }),
      ),
      linkedDirectories: thread.linkedDirectories.map((directory) => ({
        id: directory.id,
        kind: directory.kind,
        path: directory.path,
      })),
      worktreeSnapshots: (thread.worktreeSnapshots ?? []).map((snapshot) => ({
        id: snapshot.id,
        worktreePath: snapshot.worktreePath,
        repositoryPath: snapshot.repositoryPath,
        snapshotRef: snapshot.snapshotRef,
        snapshotCommit: snapshot.snapshotCommit,
        state: snapshot.state,
        archivedAt: snapshot.archivedAt ?? null,
        restoredAt: snapshot.restoredAt ?? null,
        unavailableReason: snapshot.unavailableReason ?? null,
      })),
      inbox: {
        inInbox: thread.inbox.inInbox,
        reason: thread.inbox.reason ?? null,
        lastSeenUpdatedAt: thread.inbox.lastSeenUpdatedAt ?? null,
      },
      reactions: thread.reactions ?? [],
      pinnedRank: thread.pinnedRank ?? null,
      // Include prs in the hash so refreshThreadPullRequests writes to
      // the overlay actually propagate to the renderer. Without this,
      // the next snapshot tick computes an identical hash, gets marked
      // unchanged, and the renderer keeps the stale empty thread.prs.
      prs: (thread.prs ?? []).map((pr) => ({
        number: pr.number,
        org: pr.org,
        repo: pr.repo,
        state: pr.state,
        url: pr.url,
      })),
      // Include the breadcrumb fields (parentTitle / ancestorTitle) in
      // the hash so the controller's `refreshBindingFromInbound`
      // self-heal — which fills these in lazily when the first inbound
      // event after a bind carries fresher ancestry — actually
      // propagates to the renderer. Without them the next snapshot tick
      // computes an identical hash, marks it unchanged, and the chip
      // tooltip stays on the stale value (issue #191).
      messagingBindings: (thread.messagingBindings ?? []).map((binding) => ({
        bindingId: binding.bindingId,
        platform: binding.platform,
        conversationTitle: binding.conversationTitle ?? null,
        parentTitle: binding.parentTitle ?? null,
        ancestorTitle: binding.ancestorTitle ?? null,
      })),
      automationSummary: thread.automationSummary
        ? {
            totalCount: thread.automationSummary.totalCount,
            enabledCount: thread.automationSummary.enabledCount,
            pausedCount: thread.automationSummary.pausedCount,
            nextRunAt: thread.automationSummary.nextRunAt ?? null,
            lastRunAt: thread.automationSummary.lastRunAt ?? null,
            pendingRunCount: thread.automationSummary.pendingRunCount,
            coalescedWindowCount: thread.automationSummary.coalescedWindowCount,
            skippedSinceLastCompletedCount:
              thread.automationSummary.skippedSinceLastCompletedCount,
            automations: thread.automationSummary.automations.map((automation) => ({
              id: automation.id,
              name: automation.name,
              status: automation.status,
              scheduleSummary: automation.scheduleSummary,
              backlogPolicy: automation.backlogPolicy,
              nextRunAt: automation.nextRunAt ?? null,
              lastRunAt: automation.lastRunAt ?? null,
              lastRunStatus: automation.lastRunStatus ?? null,
              pendingRunCount: automation.pendingRunCount ?? null,
              coalescedWindowCount: automation.coalescedWindowCount ?? null,
              updatedAt: automation.updatedAt,
            })),
          }
        : null,
    })),
    directories: (params.directories ?? []).map((directory) => ({
      key: directory.key,
      kind: directory.kind,
      label: directory.label,
      path: directory.path ?? null,
      threadKeys: directory.threadKeys,
      needsAttentionCount: directory.needsAttentionCount,
      latestUpdatedAt: directory.latestUpdatedAt ?? null,
      // Unit E (plan 2026-05-09-002): directory pinning. Include
      // `pinnedRank` in the hash so pin mutations invalidate the
      // unchanged-snapshot short-circuit. Without this, the renderer
      // never sees the new pin state.
      pinnedRank: directory.pinnedRank ?? null,
      launchpad: directory.launchpad
        ? {
            backend: directory.launchpad.backend,
            executionMode: directory.launchpad.executionMode,
            prompt: directory.launchpad.prompt,
            imageAttachments: (directory.launchpad.imageAttachments ?? []).map((attachment) => ({
              id: attachment.id,
              height: attachment.height ?? null,
              name: attachment.name,
              size: attachment.size,
              type: attachment.type,
              url: attachment.url,
              width: attachment.width ?? null,
            })),
            workMode: directory.launchpad.workMode,
            branchName: directory.launchpad.branchName ?? null,
            registeredAt: directory.launchpad.registeredAt ?? null,
            codexEnvironmentId:
              directory.launchpad.codexEnvironmentId ?? null,
            codexEnvironmentExecutionTarget:
              directory.launchpad.codexEnvironmentExecutionTarget ?? null,
            codexEnvironmentSetupEnabled:
              directory.launchpad.codexEnvironmentSetupEnabled ?? null,
            codexEnvironmentActionId:
              directory.launchpad.codexEnvironmentActionId ?? null,
            codexEnvironmentOptions: (
              directory.launchpad.codexEnvironmentOptions ?? []
            ).map((environment) => ({
              id: environment.id,
              name: environment.name,
              sourcePath: environment.sourcePath,
              setupScript: environment.setupScript ?? null,
              cleanupScript: environment.cleanupScript ?? null,
              actions: environment.actions.map((action) => ({
                id: action.id,
                name: action.name,
                icon: action.icon ?? null,
                command: action.command,
              })),
            })),
            settingsTouchedAt: directory.launchpad.settingsTouchedAt ?? null,
            updatedAt: directory.launchpad.updatedAt,
          }
        : null,
      gitStatus: directory.gitStatus
        ? {
            currentBranch: directory.gitStatus.currentBranch ?? null,
            defaultBranch: directory.gitStatus.defaultBranch ?? null,
            upstreamBranch: directory.gitStatus.upstreamBranch ?? null,
            ahead: directory.gitStatus.ahead ?? null,
            behind: directory.gitStatus.behind ?? null,
            branches: directory.gitStatus.branches ?? [],
            handoffBranches: directory.gitStatus.handoffBranches ?? [],
            syncState: directory.gitStatus.syncState ?? null,
          }
        : null,
    })),
    launchpadDefaults: params.launchpadDefaults ?? {
      backend: "codex",
      executionMode: "default",
    },
  });
}
