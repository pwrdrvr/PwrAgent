import type {
  MessagingActiveTurnSummary,
  MessagingBindingRecord,
  NavigationDirectorySummary,
  NavigationLaunchpadDefaults,
  NavigationSnapshot,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import { buildThreadIdentityKey } from "@pwragnt/shared";

export type MessagingResolvedThreadState = {
  activeTurn?: MessagingActiveTurnSummary;
  directoryPath?: string;
  executionMode?: ThreadExecutionMode;
  fastMode?: boolean;
  gitBranch?: string;
  launchpadDefaults?: NavigationLaunchpadDefaults;
  missing: boolean;
  model?: string;
  observedGitBranch?: string;
  projectLabel?: string;
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
  navigation: NavigationSnapshot;
}): MessagingResolvedThreadState {
  const threadKey = buildThreadIdentityKey(params.binding.backend, params.binding.threadId);
  const thread = params.navigation.threads.find(
    (candidate) =>
      candidate.source === params.binding.backend &&
      candidate.id === params.binding.threadId,
  );

  if (!thread) {
    return {
      activeTurn: params.activeTurn,
      launchpadDefaults: params.navigation.launchpadDefaults,
      missing: true,
      threadKey,
    };
  }

  const directory = primaryDirectoryForThread(params.navigation, threadKey);
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
    directoryPath: linkedDirectory?.path ?? directory?.path,
    executionMode: thread.executionMode,
    fastMode: thread.fastMode,
    gitBranch: thread.gitBranch,
    launchpadDefaults: params.navigation.launchpadDefaults,
    missing: false,
    model: thread.model,
    observedGitBranch: thread.observedGitBranch,
    projectLabel: linkedDirectory?.label ?? directory?.label,
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
