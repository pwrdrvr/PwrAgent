import { findThreadForBinding } from "./messaging-callback-helpers";
import type { LinkedDirectorySummary, MessagingBindingTargetKind, MessagingToolUpdateMode, NavigationDirectorySummary, NavigationSnapshot } from "@pwragent/shared";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import type { MessagingThreadAdmissionState } from "./messaging-adapter.js";
import { type MessagingWorkspaceHandoffContext } from "./messaging-status-card.js";
import { isMessagingThreadContext, type MessagingNavigationContext, type MessagingThreadContext } from "./messaging-thread-state.js";

export function threadContextForAdmissionState(
  _binding: MessagingBindingRecord,
  state: MessagingThreadAdmissionState,
): MessagingThreadContext {
  return { kind: "thread", thread: state.thread };
}

export function normalizeConversationTitle(title: string | undefined): string | undefined {
  const normalized = title?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

export function conversationKindLabel(kind: MessagingBindingRecord["channel"]["conversation"]["kind"]): string {
  switch (kind) {
    case "topic":
      return "topic";
    case "thread":
      return "thread";
    case "channel":
      return "channel";
    case "dm":
      return "conversation";
  }
}

export function isDefaultAgentRouteBinding(binding: MessagingBindingRecord): boolean {
  return binding.id.startsWith("default-agent-route:");
}

export function handoffContextForBinding(
  binding: MessagingBindingRecord,
  navigation: MessagingNavigationContext,
): MessagingWorkspaceHandoffContext | undefined {
  const thread = findThreadForBinding(navigation, binding);
  if (!thread || thread.workspaceHandoff?.available === false) {
    return undefined;
  }

  const worktreeDirectory = thread.linkedDirectories.find(
    (directory) => directory.kind === "worktree" || Boolean(directory.worktreePath),
  );
  if (worktreeDirectory) {
    const repositoryPath = worktreeDirectory.path;
    const workingDirectoryPath = worktreeDirectory.worktreePath ?? worktreeDirectory.path;
    const branch = thread.observedGitBranch ?? thread.gitBranch;
    if (!repositoryPath || !workingDirectoryPath) {
      return undefined;
    }
    return {
      backend: binding.backend,
      branch,
      leaveLocalBranches: [],
      projectLabel: worktreeDirectory.label,
      repositoryPath,
      threadId: binding.threadId,
      threadTitle: thread.title,
      workingDirectoryPath,
      workspaceKind: "worktree",
    };
  }

  const localDirectory =
    thread.linkedDirectories.find((directory) => directory.kind === "local") ??
    thread.linkedDirectories[0];
  const sourcePath = localDirectory?.path ?? thread.projectKey;
  if (!sourcePath) return undefined;
  const directorySummary = isMessagingThreadContext(navigation) ? navigation.directory : localDirectory ? findNavigationDirectory(navigation, localDirectory) : undefined;
  const branch =
    thread.observedGitBranch ??
    thread.gitBranch ??
    directorySummary?.gitStatus?.currentBranch;
  const leaveLocalBranches = (
    directorySummary?.gitStatus?.handoffBranches ??
    directorySummary?.gitStatus?.branches?.filter((candidate) => candidate !== branch) ??
    []
  ).filter(
    (candidate, index, branches) =>
      candidate !== "HEAD" && candidate !== branch && branches.indexOf(candidate) === index,
  );
  const leaveLocalBranchChoices = branch ? ["HEAD", ...leaveLocalBranches] : [];

  return {
    backend: binding.backend,
    branch,
    leaveLocalBranches: leaveLocalBranchChoices,
    projectLabel: localDirectory?.label,
    repositoryPath: sourcePath,
    threadId: binding.threadId,
    threadTitle: thread.title,
    workingDirectoryPath: sourcePath,
    workspaceKind: "local",
  };
}

export function findNavigationDirectory(
  navigation: NavigationSnapshot,
  linkedDirectory: LinkedDirectorySummary,
): NavigationDirectorySummary | undefined {
  return navigation.directories.find(
    (directory) =>
      directory.key === linkedDirectory.id ||
      directory.path === linkedDirectory.path ||
      (linkedDirectory.worktreePath && directory.path === linkedDirectory.worktreePath),
  );
}

export function describeConversation(
  conversation: MessagingBindingRecord["channel"]["conversation"],
): string {
  const pieces = [
    conversation.ancestorTitle,
    conversation.parentTitle,
    conversation.title,
  ].filter((piece): piece is string => Boolean(piece));
  return pieces.length > 0 ? pieces.join(" / ") : conversation.id;
}

export type MessagingToolUpdateDefaultModeResolver =
  | MessagingToolUpdateMode
  | ((
    targetKind: MessagingBindingTargetKind,
  ) => MessagingToolUpdateMode | Promise<MessagingToolUpdateMode>);
