import type {
  DirectoryLaunchpadOverlayState,
  LinkedDirectorySummary,
  NavigationDirectoryGitStatus,
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  compareThreadsByCreatedAtDesc,
  isToolManagedWorktreePath,
} from "@pwragent/shared";

type DirectoryDescriptor = Pick<
  NavigationDirectorySummary,
  "key" | "kind" | "label" | "path"
>;

function pathBaseName(value?: string): string {
  if (!value) {
    return value ?? "";
  }

  const normalized = value.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

function normalizeComparablePath(value?: string): string | undefined {
  const normalized = value?.trim().replace(/[\\/]+$/, "");
  return normalized || undefined;
}

function isInternalDirectoryLabel(value?: string): boolean {
  return Boolean(value?.startsWith("directory:") || value?.startsWith("workspace:"));
}

function displayDirectoryLabel(params: {
  kind?: DirectoryDescriptor["kind"];
  label?: string;
  path?: string;
}): string {
  const label = params.label?.trim();
  if (label && !isInternalDirectoryLabel(label)) {
    return label;
  }

  if (params.kind === "workspace") {
    return "Workspaces";
  }

  return pathBaseName(params.path) || label || "Directory";
}

function pathFromDirectoryKey(directoryKey: string): string | undefined {
  const directoryPath = directoryKey.startsWith("directory:")
    ? directoryKey.slice("directory:".length)
    : directoryKey.startsWith("workspace:")
      ? directoryKey.slice("workspace:".length)
      : undefined;
  return directoryPath?.trim() || undefined;
}

function matchScratchProjectsRoot(value: string): string | undefined {
  const scratchWorkspaceRootMatch = value.match(
    /^(.*[\\/]\.pwrag(?:ent|nt)(?:[\\/]profiles[\\/][^\\/]+)?[\\/]projects)$/,
  );
  if (scratchWorkspaceRootMatch) {
    return scratchWorkspaceRootMatch[1];
  }

  const scratchWorkspaceMatch = value.match(
    /^(.*[\\/]\.pwrag(?:ent|nt)(?:[\\/]profiles[\\/][^\\/]+)?[\\/]projects)[\\/][^\\/]+$/,
  );
  return scratchWorkspaceMatch?.[1];
}

function classifyDirectory(directory: LinkedDirectorySummary): DirectoryDescriptor {
  // Match both current ".pwragent" and legacy ".pwragnt" home directory names
  // so pre-rebrand thread data classifies correctly.
  const scratchProjectsRoot = matchScratchProjectsRoot(directory.path);
  if (scratchProjectsRoot) {
    return {
      key: `workspace:${scratchProjectsRoot}`,
      kind: "workspace",
      label: "Workspaces",
      path: scratchProjectsRoot,
    };
  }

  const repoWorktreeMatch = directory.path.match(
    /^(.*)[\\/]\.worktrees[\\/][^\\/]+(?:[\\/].*)?$/,
  );
  if (repoWorktreeMatch) {
    const canonicalPath = repoWorktreeMatch[1];
    return {
      key: `directory:${canonicalPath}`,
      kind: "directory",
      label: pathBaseName(canonicalPath),
      path: canonicalPath,
    };
  }

  const codexWorktreeMatch = directory.path.match(
    /^[\\/].*[\\/]\.codex(?:[\\/]profiles[\\/][^\\/]+)?[\\/]worktrees[\\/][^\\/]+[\\/]([^\\/]+)(?:[\\/].*)?$/,
  );
  if (codexWorktreeMatch) {
    const canonicalPath = directory.path.replace(/[\\/]+$/, "");
    return {
      key: `directory:${canonicalPath}`,
      kind: "directory",
      label: codexWorktreeMatch[1],
      path: canonicalPath,
    };
  }

  return {
    key: `directory:${directory.path}`,
    kind: "directory",
    label: displayDirectoryLabel({
      kind: "directory",
      label: directory.label,
      path: directory.path,
    }),
    path: directory.path,
  };
}

function collectStablePathByLabel(
  threads: NavigationThreadSummary[],
): Map<string, string | undefined> {
  const pathsByLabel = new Map<string, Set<string>>();

  for (const thread of threads) {
    for (const directory of thread.linkedDirectories) {
      const descriptor = classifyDirectory(directory);
      if (!descriptor.path || descriptor.kind !== "directory") {
        continue;
      }
      if (isToolManagedWorktreePath(descriptor.path)) {
        continue;
      }

      const paths = pathsByLabel.get(descriptor.label) ?? new Set<string>();
      paths.add(descriptor.path);
      pathsByLabel.set(descriptor.label, paths);
    }
  }

  return new Map(
    [...pathsByLabel.entries()].map(([label, paths]) => [
      label,
      paths.size === 1 ? [...paths][0] : undefined,
    ]),
  );
}

function ensureSummary(
  summaries: Map<string, NavigationDirectorySummary>,
  descriptor: DirectoryDescriptor,
): NavigationDirectorySummary {
  const existing = summaries.get(descriptor.key);
  if (existing) {
    return existing;
  }

  const created: NavigationDirectorySummary = {
    key: descriptor.key,
    kind: descriptor.kind,
    label: descriptor.label,
    path: descriptor.path,
    threadKeys: [],
    needsAttentionCount: 0,
  };
  summaries.set(descriptor.key, created);
  return created;
}

function workspaceRootSet(
  workspaceRoots?: string[],
): Set<string> | undefined {
  const roots = new Set(
    (workspaceRoots ?? [])
      .map(normalizeComparablePath)
      .filter((root): root is string => Boolean(root)),
  );
  return roots.size > 0 ? roots : undefined;
}

function isAllowedWorkspaceRoot(
  descriptor: DirectoryDescriptor,
  allowedWorkspaceRoots: Set<string> | undefined,
): boolean {
  if (descriptor.kind !== "workspace" || !allowedWorkspaceRoots) {
    return true;
  }

  const workspacePath = normalizeComparablePath(descriptor.path);
  return Boolean(workspacePath && allowedWorkspaceRoots.has(workspacePath));
}

function hasPersistableLaunchpadState(
  launchpad: DirectoryLaunchpadOverlayState,
): boolean {
  return (
    launchpad.prompt.trim().length > 0 ||
    (launchpad.imageAttachments?.length ?? 0) > 0 ||
    launchpad.registeredAt !== undefined ||
    launchpad.settingsTouchedAt !== undefined
  );
}

function compareWorkspaceSummaryPreference(
  left: NavigationDirectorySummary,
  right: NavigationDirectorySummary,
  preferredWorkspaceRoots?: string[],
): number {
  if (preferredWorkspaceRoots && preferredWorkspaceRoots.length > 0) {
    const rootRank = new Map(
      preferredWorkspaceRoots.map((root, index) => [root, index]),
    );
    const leftRootRank =
      rootRank.get(normalizeComparablePath(left.path) ?? "") ?? Number.MAX_SAFE_INTEGER;
    const rightRootRank =
      rootRank.get(normalizeComparablePath(right.path) ?? "") ?? Number.MAX_SAFE_INTEGER;
    if (leftRootRank !== rightRootRank) {
      return leftRootRank - rightRootRank;
    }
  }

  const leftLaunchpadUpdatedAt = left.launchpad?.updatedAt ?? 0;
  const rightLaunchpadUpdatedAt = right.launchpad?.updatedAt ?? 0;
  const launchpadUpdatedDelta = rightLaunchpadUpdatedAt - leftLaunchpadUpdatedAt;
  if (launchpadUpdatedDelta !== 0) {
    return launchpadUpdatedDelta;
  }

  const updatedDelta = (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0);
  return updatedDelta !== 0 ? updatedDelta : left.key.localeCompare(right.key);
}

function chooseWorkspaceSummary(
  workspaces: NavigationDirectorySummary[],
  preferredWorkspaceRoots?: string[],
): NavigationDirectorySummary {
  const withPendingLaunchpads = workspaces.filter(
    (workspace) =>
      workspace.launchpad && hasPersistableLaunchpadState(workspace.launchpad),
  );
  const candidates =
    withPendingLaunchpads.length > 0 ? withPendingLaunchpads : workspaces;
  return [...candidates].sort((left, right) =>
    compareWorkspaceSummaryPreference(left, right, preferredWorkspaceRoots),
  )[0]!;
}

function collapseWorkspaceSummaries(params: {
  summaries: NavigationDirectorySummary[];
  threads: NavigationThreadSummary[];
  workspaceRoots?: string[];
}): NavigationDirectorySummary[] {
  const workspaces = params.summaries.filter(
    (summary) => summary.kind === "workspace",
  );
  if (workspaces.length <= 1) {
    return params.summaries;
  }

  const preferred = chooseWorkspaceSummary(workspaces, params.workspaceRoots);
  const threadOrder = buildThreadCreationOrder(params.threads);
  const inboxByThreadKey = new Map(
    params.threads.map((thread) => [
      buildThreadIdentityKey(thread.source, thread.id),
      thread.inbox.inInbox,
    ]),
  );
  const threadKeys = [...new Set(workspaces.flatMap((summary) => summary.threadKeys))]
    .sort(
      (left, right) =>
        (threadOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (threadOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
    );
  const latestUpdatedAt = Math.max(
    ...workspaces.map((summary) => summary.latestUpdatedAt ?? 0),
  );

  return [
    {
      ...preferred,
      threadKeys,
      needsAttentionCount: threadKeys.reduce(
        (count, threadKey) => count + (inboxByThreadKey.get(threadKey) ? 1 : 0),
        0,
      ),
      latestUpdatedAt: latestUpdatedAt || undefined,
      launchpad: preferred.launchpad
        ? {
            ...preferred.launchpad,
            directoryKey: preferred.key,
            directoryKind: "workspace",
            directoryLabel: preferred.label,
            directoryPath: preferred.path,
          }
        : undefined,
    },
    ...params.summaries.filter((summary) => summary.kind !== "workspace"),
  ];
}

function buildThreadCreationOrder(
  threads: NavigationThreadSummary[],
): Map<string, number> {
  return new Map(
    [...threads]
      .sort(compareThreadsByCreatedAtDesc)
      .map((thread, index) => [
        buildThreadIdentityKey(thread.source, thread.id),
        index,
      ]),
  );
}

function sortDirectoryThreadKeysByCreation(
  summaries: NavigationDirectorySummary[],
  threads: NavigationThreadSummary[],
): NavigationDirectorySummary[] {
  const threadOrder = buildThreadCreationOrder(threads);

  return summaries.map((summary) => ({
    ...summary,
    threadKeys: [...summary.threadKeys].sort(
      (left, right) =>
        (threadOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (threadOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
    ),
  }));
}

export function buildDirectorySummaries(params: {
  threads: NavigationThreadSummary[];
  launchpadsByKey?: Record<string, DirectoryLaunchpadOverlayState | undefined>;
  gitStatusByKey?: Record<string, NavigationDirectoryGitStatus | undefined>;
  workspaceRoots?: string[];
}): NavigationDirectorySummary[] {
  const summaries = new Map<string, NavigationDirectorySummary>();
  const stablePathByLabel = collectStablePathByLabel(params.threads);
  const allowedWorkspaceRoots = workspaceRootSet(params.workspaceRoots);

  for (const thread of params.threads) {
    const threadKey = buildThreadIdentityKey(thread.source, thread.id);

    if (thread.linkedDirectories.length === 0) {
      if (!thread.projectKey?.trim()) {
        const summary = ensureSummary(summaries, {
          key: "unlinked",
          kind: "unlinked",
          label: "No linked directory",
        });
        if (!summary.threadKeys.includes(threadKey)) {
          summary.threadKeys.push(threadKey);
        }
        if (thread.inbox.inInbox) {
          summary.needsAttentionCount += 1;
        }
        summary.latestUpdatedAt = Math.max(summary.latestUpdatedAt ?? 0, thread.updatedAt ?? 0);
      }
      continue;
    }

    const seenDescriptors = new Set<string>();
    for (const directory of thread.linkedDirectories) {
      const descriptor = classifyDirectory(directory);
      const stablePath = stablePathByLabel.get(descriptor.label);
      const normalizedDescriptor =
        descriptor.path && isToolManagedWorktreePath(descriptor.path) && stablePath
          ? {
              ...descriptor,
              key: `directory:${stablePath}`,
              path: stablePath,
            }
          : descriptor.path || descriptor.kind !== "directory"
          ? descriptor
          : stablePath
            ? {
                ...descriptor,
                key: `directory:${stablePath}`,
                path: stablePath,
              }
            : descriptor;
      if (!isAllowedWorkspaceRoot(normalizedDescriptor, allowedWorkspaceRoots)) {
        continue;
      }
      if (seenDescriptors.has(normalizedDescriptor.key)) {
        continue;
      }
      seenDescriptors.add(normalizedDescriptor.key);
      const summary = ensureSummary(summaries, normalizedDescriptor);
      if (!summary.threadKeys.includes(threadKey)) {
        summary.threadKeys.push(threadKey);
      }
      if (thread.inbox.inInbox) {
        summary.needsAttentionCount += 1;
      }
      summary.latestUpdatedAt = Math.max(summary.latestUpdatedAt ?? 0, thread.updatedAt ?? 0);
    }
  }

  for (const [directoryKey, launchpad] of Object.entries(params.launchpadsByKey ?? {})) {
    if (!launchpad || !hasPersistableLaunchpadState(launchpad)) {
      continue;
    }
    const launchpadPath = launchpad.directoryPath ?? pathFromDirectoryKey(directoryKey);
    const launchpadLabel = displayDirectoryLabel({
      kind: launchpad.directoryKind,
      label: launchpad.directoryLabel,
      path: launchpadPath,
    });
    if (
      !isAllowedWorkspaceRoot(
        {
          key: directoryKey,
          kind: launchpad.directoryKind,
          label: launchpadLabel,
          path: launchpadPath,
        },
        allowedWorkspaceRoots,
      )
    ) {
      continue;
    }
    const summary = ensureSummary(summaries, {
      key: directoryKey,
      kind: launchpad.directoryKind,
      label: launchpadLabel,
      path: launchpadPath,
    });
    summary.launchpad = {
      ...launchpad,
      directoryLabel: launchpadLabel,
      directoryPath: launchpadPath,
    };
    summary.latestUpdatedAt = Math.max(summary.latestUpdatedAt ?? 0, launchpad.updatedAt);
  }

  for (const [directoryKey, gitStatus] of Object.entries(params.gitStatusByKey ?? {})) {
    if (!gitStatus) {
      continue;
    }
    const summary = summaries.get(directoryKey);
    if (summary) {
      summary.gitStatus = gitStatus;
    }
  }

  return sortDirectoryThreadKeysByCreation(
    collapseWorkspaceSummaries({
      summaries: [...summaries.values()],
      threads: params.threads,
      workspaceRoots: params.workspaceRoots
        ?.map(normalizeComparablePath)
        .filter((root): root is string => Boolean(root)),
    }),
    params.threads,
  ).sort((left, right) => left.label.localeCompare(right.label));
}
