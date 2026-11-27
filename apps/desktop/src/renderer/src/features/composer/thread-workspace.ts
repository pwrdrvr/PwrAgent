import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadWorkspaceHandoffDirection } from "@pwragent/shared/contracts/normalized-app-server";
import { normalizeGitOriginUrl } from "@pwragent/shared/directory-navigation";
import { resolveLifecycleState } from "../pr-status/pr-chip-state";

/*
 * What a thread's workspace is and what can be done to it. The composer and
 * the rail's Details tab both read these, so the two agree on which checkout
 * a thread works in, which PRs belong to it, and whether it can be handed off.
 */

export function formatThreadWorkspaceLabel(thread?: NavigationThreadSummary): string | undefined {
  if (!thread) {
    return undefined;
  }

  if (thread.linkedDirectories.some((directory) => directory.kind === "worktree")) {
    return "Worktree";
  }

  if (
    thread.linkedDirectories.some((directory) => directory.kind === "local") ||
    thread.projectKey
  ) {
    return "Local";
  }

  return undefined;
}

export type ThreadWorkspace = {
  mode: "local" | "worktree";
  /** True only when the path is known to be a git local/worktree relationship. */
  gitBacked: boolean;
  /** Repository/local checkout path. In Worktree mode this is not the command CWD. */
  repositoryPath: string;
  /** Current workspace path for opening apps and running thread-scoped commands. */
  sourcePath: string;
};

export function getThreadWorkspace(thread: NavigationThreadSummary): ThreadWorkspace | undefined {
  const worktreeDirectory = thread.linkedDirectories.find(
    (directory) => directory.kind === "worktree"
  );
  if (worktreeDirectory) {
    return {
      mode: "worktree",
      gitBacked: true,
      repositoryPath: worktreeDirectory.path,
      sourcePath: worktreeDirectory.worktreePath ?? worktreeDirectory.path,
    };
  }

  const localDirectory = thread.linkedDirectories.find(
    (directory) => directory.kind === "local"
  );
  if (localDirectory) {
    return {
      mode: "local",
      gitBacked: true,
      repositoryPath: localDirectory.path,
      sourcePath: localDirectory.path,
    };
  }

  if (thread.projectKey) {
    return {
      mode: "local",
      gitBacked: false,
      repositoryPath: thread.projectKey,
      sourcePath: thread.projectKey,
    };
  }

  return undefined;
}

export function hasPrimaryWorkspacePullRequest(
  thread: NavigationThreadSummary,
): boolean {
  return primaryWorkspacePullRequests(thread).length > 0;
}

export function primaryWorkspacePullRequests(
  thread: NavigationThreadSummary,
): NonNullable<NavigationThreadSummary["prs"]> {
  const primaryRepository = getPrimaryWorkspaceRepository(thread);
  if (!primaryRepository) return [];
  return (thread.prs ?? []).filter((pr) =>
    normalizeGitOriginUrl(`${pr.provider}/${pr.org}/${pr.repo}`)
      === primaryRepository,
  );
}

/**
 * What an Auto-fix chip says when every PR on the primary workspace has
 * merged or closed: it stays on, with nothing to repair. Undefined while any
 * of them is open, or when none is attached.
 */
export function describeEndedPullRequestAutoFix(
  thread: NavigationThreadSummary,
): string | undefined {
  const prs = primaryWorkspacePullRequests(thread);
  if (prs.length === 0) return undefined;
  let latest: { number: number; state: "merged" | "closed" } | undefined;
  for (const pr of prs) {
    const state = resolveLifecycleState(pr);
    if (state !== "merged" && state !== "closed") return undefined;
    if (!latest || pr.number > latest.number) latest = { number: pr.number, state };
  }
  return latest
    ? `Auto-fix PR is on, but #${latest.number} ${latest.state}. It starts again when an open PR is linked.`
    : undefined;
}

export function getPrimaryWorkspaceRepository(
  thread: NavigationThreadSummary,
): string | undefined {
  return (
    normalizeGitOriginUrl(thread.primaryGitRepository)
    ?? normalizeGitOriginUrl(thread.gitOriginUrl)
  );
}

export function isThreadWorkspaceHandoffEligible(params: {
  sourceBranch?: string;
  threadWorkspace?: ThreadWorkspace;
}): boolean {
  if (!params.threadWorkspace) {
    return false;
  }

  if (!params.threadWorkspace.gitBacked) {
    return false;
  }

  if (params.threadWorkspace.mode === "worktree") {
    return true;
  }

  return Boolean(params.sourceBranch?.trim());
}

/**
 * A request, from outside the composer, to open its workspace handoff dialog
 * in one direction. `id` changes with each request, so asking twice for the
 * same direction opens the dialog twice.
 */
export type WorkspaceHandoffRequest = {
  id: number;
  direction: ThreadWorkspaceHandoffDirection;
};

/**
 * What the composer's handoff dialog would accept now: moving the thread to
 * a project, and handing its checkout to a worktree or Local.
 */
export type WorkspaceHandoffAvailability = {
  project: boolean;
  workspace: boolean;
};

/** Whether the composer would open the dialog for `direction`. */
export function isWorkspaceHandoffAvailable(
  availability: WorkspaceHandoffAvailability | undefined,
  direction: ThreadWorkspaceHandoffDirection,
): boolean {
  if (!availability) return false;
  return direction === "to-project" ? availability.project : availability.workspace;
}

/**
 * The handoffs a thread's workspace offers, in menu order, as the composer's
 * Worktree menu lists them: a worktree can go to a new worktree or to Local,
 * a local checkout to a new worktree, and either can move to a project.
 */
export function listWorkspaceHandoffDirections(
  workspace: ThreadWorkspace | undefined,
): ThreadWorkspaceHandoffDirection[] {
  if (!workspace) return [];
  return workspace.mode === "worktree"
    ? ["worktree-to-worktree", "worktree-to-local", "to-project"]
    : ["local-to-worktree", "to-project"];
}

export function formatWorkspaceHandoffDirection(
  direction: ThreadWorkspaceHandoffDirection,
): string {
  switch (direction) {
    case "worktree-to-worktree":
    case "local-to-worktree":
      return "Handoff to New Worktree";
    case "worktree-to-local":
      return "Handoff to Local";
    case "to-project":
      return "Move to Project";
  }
}
