import type {
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "./contracts/navigation";

const REVIEW_PREFERRED_BASE_BRANCHES = ["main", "master", "develop", "trunk"];
const REVIEW_REMOTE_AGNOSTIC_BASE_BRANCH_PATTERN =
  /^(main|master|develop|development|trunk)$|^(release|releases|stable|support|maintenance)\//;

export function buildReviewBranchOptions(params: {
  directory?: NavigationDirectorySummary;
  thread?: NavigationThreadSummary;
}): string[] {
  const threadCurrentBranches = [
    params.thread?.gitBranch,
    params.thread?.observedGitBranch,
  ]
    .map((branch) => branch?.trim())
    .filter((branch): branch is string => Boolean(branch));
  const currentBranches = new Set(
    [
      ...threadCurrentBranches,
      ...(threadCurrentBranches.length === 0
        ? [params.directory?.gitStatus?.currentBranch]
        : []),
    ]
      .map((branch) => branch?.trim())
      .filter((branch): branch is string => Boolean(branch)),
  );
  const isCurrentBranch = (candidate?: string): boolean => {
    const value = candidate?.trim();
    if (!value) {
      return false;
    }
    if (currentBranches.has(value)) {
      return true;
    }
    return (
      value.startsWith("origin/")
      && currentBranches.has(value.slice("origin/".length))
    );
  };
  const upstreamBranch = params.directory?.gitStatus?.upstreamBranch?.replace(
    /^origin\//,
    "",
  );
  const directoryCurrentBranch = params.directory?.gitStatus?.currentBranch
    ?.trim()
    .replace(/^origin\//, "");
  const directoryDefaultBranch = params.directory?.gitStatus?.defaultBranch
    ?.trim()
    .replace(/^origin\//, "");
  const baseBranches = params.directory?.gitStatus?.baseBranches ?? [];
  const knownBranches = new Set(
    [
      ...baseBranches,
      ...(params.directory?.gitStatus?.branches ?? []),
      params.directory?.gitStatus?.defaultBranch,
      upstreamBranch,
    ]
      .map((branch) => branch?.trim())
      .filter((branch): branch is string => Boolean(branch)),
  );
  const options = new Set<string>();
  const push = (
    candidate?: string,
    optionsForCandidate?: { allowCurrent?: boolean },
  ): void => {
    const value = candidate?.trim();
    if (
      value
      && (optionsForCandidate?.allowCurrent || !isCurrentBranch(value))
    ) {
      options.add(value);
    }
  };
  const pushIfKnown = (candidate?: string): void => {
    const value = candidate?.trim();
    if (value && knownBranches.has(value)) {
      push(value);
    }
  };
  const pushPreferredDefault = (candidate?: string): void => {
    const value = candidate?.trim().replace(/^origin\//, "");
    if (!value) {
      return;
    }
    pushIfKnown(`origin/${value}`);
    pushIfKnown(value);
  };
  const pushDirectoryDefault = (): void => {
    if (!directoryDefaultBranch) {
      return;
    }
    if (
      threadCurrentBranches.length > 0
      && directoryDefaultBranch === directoryCurrentBranch
      && !REVIEW_REMOTE_AGNOSTIC_BASE_BRANCH_PATTERN.test(directoryDefaultBranch)
    ) {
      return;
    }
    pushPreferredDefault(directoryDefaultBranch);
  };
  const pushInferredBaseBranch = (candidate?: string): void => {
    const value = candidate?.trim();
    if (!value) {
      return;
    }

    const optionCount = options.size;
    if (value.startsWith("origin/")) {
      pushIfKnown(value);
      pushIfKnown(value.slice("origin/".length));
    } else if (REVIEW_REMOTE_AGNOSTIC_BASE_BRANCH_PATTERN.test(value)) {
      pushIfKnown(`origin/${value}`);
      pushIfKnown(value);
    } else {
      pushIfKnown(value);
    }

    if (options.size === optionCount) {
      push(value);
    }
  };

  pushInferredBaseBranch(params.thread?.gitWorkingState?.baseBranch);
  pushDirectoryDefault();
  for (const branch of REVIEW_PREFERRED_BASE_BRANCHES) {
    pushPreferredDefault(branch);
  }
  push("main", { allowCurrent: true });
  pushIfKnown(upstreamBranch);
  for (const candidate of baseBranches) {
    push(candidate);
  }
  push(params.thread?.gitBranch);
  push(params.thread?.observedGitBranch);
  push(params.directory?.gitStatus?.currentBranch);
  for (const candidate of params.directory?.gitStatus?.branches ?? []) {
    push(candidate);
  }
  return [...options];
}

/**
 * Chooses the thread's primary workspace when it is a linked project with
 * reviewable changes against its inferred base. This keeps multi-project
 * reviews unambiguous by default without guessing for a clean primary
 * workspace.
 */
export function findPreferredReviewWorkspaceCwd(
  thread?: Pick<
    NavigationThreadSummary,
    "gitWorkingState" | "linkedDirectories" | "projectKey"
  >,
): string | undefined {
  const projectKey = normalizeReviewWorkspacePath(thread?.projectKey);
  const gitWorkingState = thread?.gitWorkingState;
  if (
    !projectKey ||
    !gitWorkingState?.baseBranch ||
    (
      (gitWorkingState.baseAheadCommitCount ?? 0) <= 0 &&
      gitWorkingState.dirtyFiles <= 0 &&
      gitWorkingState.untrackedFiles <= 0
    )
  ) {
    return undefined;
  }

  return (thread?.linkedDirectories ?? [])
    .flatMap((directory) => {
      const cwd = (directory.worktreePath ?? directory.path).trim();
      const workspacePath = normalizeReviewWorkspacePath(cwd);
      return workspacePath && reviewWorkspaceContains(workspacePath, projectKey)
        ? [{ cwd, workspacePath }]
        : [];
    })
    .sort((left, right) => right.workspacePath.length - left.workspacePath.length)[0]
    ?.cwd;
}

function normalizeReviewWorkspacePath(value?: string): string | undefined {
  const normalized = value?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || undefined;
}

function reviewWorkspaceContains(
  workspacePath: string,
  projectPath: string,
): boolean {
  return (
    workspacePath === projectPath ||
    projectPath.startsWith(`${workspacePath}/`)
  );
}
