import type {
  NavigationDirectorySummary,
  NavigationLaunchpadDefaults,
  NavigationSnapshot,
  NavigationThreadSummary,
  BackendAcpSessionRuntimeState,
  ThreadExecutionMode,
} from "@pwragent/shared";
import type {
  MessagingActiveTurnSummary,
  MessagingBindingRecord,
} from "@pwragent/messaging-interface";
import { buildThreadIdentityKey } from "@pwragent/shared";

/** Exact thread context has no collection membership or completeness semantics. */
export type MessagingThreadContext = {
  kind: "thread";
  thread?: NavigationThreadSummary;
  defaults?: NavigationLaunchpadDefaults;
  directory?: Pick<NavigationDirectorySummary, "label" | "path" | "gitStatus">;
};

/** Legacy complete browse populations remain separate during consumer cutover. */
export type MessagingNavigationContext = NavigationSnapshot | MessagingThreadContext;

export function isMessagingThreadContext(value: MessagingNavigationContext): value is MessagingThreadContext {
  return "kind" in value && value.kind === "thread";
}

export type MessagingResolvedThreadState = {
  activeTurn?: MessagingActiveTurnSummary;
  acpRuntime?: BackendAcpSessionRuntimeState;
  directoryPath?: string;
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  gitBranch?: string;
  launchpadDefaults?: NavigationLaunchpadDefaults;
  missing: boolean;
  model?: string;
  observedGitBranch?: string;
  projectLabel?: string;
  /**
   * Pending permission-mode change waiting for the active turn to end.
   * Populated only when a user toggled while a turn was running. The
   * status card surfaces this as `Permissions: <current> → <queued>
   * (queued)` instead of the plain applied-mode label.
   */
  queuedExecutionMode?: ThreadExecutionMode;
  /** Wall-clock ms when the queue entry was created. */
  queuedExecutionModeAt?: number;
  reasoningEffort?: string;
  serviceTier?: string;
  thread?: NavigationThreadSummary;
  threadKey: string;
  title?: string;
  titleSource?: NavigationThreadSummary["titleSource"];
  workMode?: "local" | "worktree";
  worktreePath?: string;
};

export function resolveMessagingThreadState(params: {
  activeTurn?: MessagingActiveTurnSummary;
  binding: MessagingBindingRecord;
  navigation: MessagingNavigationContext;
}): MessagingResolvedThreadState {
  const threadKey = buildThreadIdentityKey(params.binding.backend, params.binding.threadId);
  const exact = isMessagingThreadContext(params.navigation) ? params.navigation : undefined;
  const defaults = exact ? exact.defaults : (params.navigation as NavigationSnapshot).launchpadDefaults;
  const thread = exact ? exact.thread : (params.navigation as NavigationSnapshot).threads.find(
    (candidate) =>
      candidate.source === params.binding.backend &&
      candidate.id === params.binding.threadId,
  );

  if (!thread) {
    return {
      activeTurn: params.activeTurn,
      launchpadDefaults: defaults,
      missing: true,
      threadKey,
    };
  }

  const directory = exact ? exact.directory : primaryDirectoryForThread(params.navigation as NavigationSnapshot, threadKey);
  const linkedDirectory =
    thread.linkedDirectories.find((candidate) => candidate.kind === "worktree") ??
    thread.linkedDirectories.find((candidate) => candidate.kind === "local") ??
    thread.linkedDirectories[0];
  const worktreeDirectory = thread.linkedDirectories.find(
    (candidate) => candidate.kind === "worktree" || candidate.worktreePath,
  );
  const worktreePath =
    worktreeDirectory?.worktreePath ??
    (worktreeDirectory?.kind === "worktree" ? worktreeDirectory.path : undefined);

  return {
    activeTurn: params.activeTurn,
    acpRuntime: thread.acpRuntime,
    directoryPath: linkedDirectory?.path ?? directory?.path,
    executionMode: thread.executionMode,
    fastMode: thread.fastMode,
    gitBranch: thread.gitBranch,
    launchpadDefaults: defaults,
    missing: false,
    model: thread.model,
    observedGitBranch: thread.observedGitBranch,
    projectLabel: linkedDirectory?.label ?? directory?.label,
    queuedExecutionMode: thread.queuedExecutionMode,
    queuedExecutionModeAt: thread.queuedExecutionModeAt,
    reasoningEffort: thread.reasoningEffort,
    serviceTier: thread.serviceTier,
    thread,
    threadKey,
    title: thread.title,
    titleSource: thread.titleSource,
    workMode: worktreePath ? "worktree" : linkedDirectory?.kind,
    worktreePath,
  };
}

function primaryDirectoryForThread(
  navigation: NavigationSnapshot,
  threadKey: string,
): NavigationDirectorySummary | undefined {
  return navigation.directories.find((directory) =>
    directory.threadKeys.includes(threadKey),
  );
}
