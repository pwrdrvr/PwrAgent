import type {
  DirectoryLaunchpadOverlayState,
  LinkedDirectorySummary,
  NavigationDirectoryGitStatus,
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";

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

function classifyDirectory(directory: LinkedDirectorySummary): DirectoryDescriptor {
  // Match both current ".pwragent" and legacy ".pwragnt" home directory names
  // so pre-rebrand thread data classifies correctly.
  const scratchWorkspaceRootMatch = directory.path.match(
    /^(.*[\\/]\.pwrag(?:ent|nt)[\\/]projects)$/,
  );
  if (scratchWorkspaceRootMatch) {
    return {
      key: `workspace:${scratchWorkspaceRootMatch[1]}`,
      kind: "workspace",
      label: "Workspaces",
      path: scratchWorkspaceRootMatch[1],
    };
  }

  const scratchWorkspaceMatch = directory.path.match(
    /^(.*[\\/]\.pwrag(?:ent|nt)[\\/]projects)[\\/][^\\/]+$/,
  );
  if (scratchWorkspaceMatch) {
    return {
      key: `workspace:${scratchWorkspaceMatch[1]}`,
      kind: "workspace",
      label: "Workspaces",
      path: scratchWorkspaceMatch[1],
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
    /^[\\/].*[\\/]\.codex[\\/]worktrees[\\/][^\\/]+[\\/]([^\\/]+)(?:[\\/].*)?$/,
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

function hasPersistableLaunchpadState(
  launchpad: DirectoryLaunchpadOverlayState,
): boolean {
  return (
    launchpad.prompt.trim().length > 0 ||
    (launchpad.imageAttachments?.length ?? 0) > 0 ||
    launchpad.settingsTouchedAt !== undefined
  );
}

export function buildDirectorySummaries(params: {
  threads: NavigationThreadSummary[];
  launchpadsByKey?: Record<string, DirectoryLaunchpadOverlayState | undefined>;
  gitStatusByKey?: Record<string, NavigationDirectoryGitStatus | undefined>;
}): NavigationDirectorySummary[] {
  const summaries = new Map<string, NavigationDirectorySummary>();
  const stablePathByLabel = collectStablePathByLabel(params.threads);

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
      const normalizedDescriptor =
        descriptor.path || descriptor.kind !== "directory"
          ? descriptor
          : stablePathByLabel.get(descriptor.label)
            ? {
                ...descriptor,
                key: `directory:${stablePathByLabel.get(descriptor.label)}`,
                path: stablePathByLabel.get(descriptor.label),
              }
            : descriptor;
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

  return [...summaries.values()].sort((left, right) => left.label.localeCompare(right.label));
}
