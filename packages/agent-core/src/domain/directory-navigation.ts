import type {
  DirectoryLaunchpadOverlayState,
  DirectoryOverlayState,
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

// Canonicalize a filesystem path for use as a stable navigation identity:
// forward slashes and no trailing separator. This is what collapses a single
// logical directory keyed via different representations into ONE row — on
// Windows the same repo/worktree can arrive as `C:\…` (codex/git native) and as
// `C:/…` (the forward slashes we normalize codex/git paths to elsewhere), and
// without this they produce two `directory:` keys → duplicate folders. No-op on
// already-POSIX paths (no backslashes, no trailing slash).
function canonicalizeNavigationPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeComparablePath(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized
    ? canonicalizeNavigationPath(normalized) || undefined
    : undefined;
}

function normalizeGitOriginUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/i);
  const candidate = sshMatch
    ? `${sshMatch[1]}/${sshMatch[2]}`
    : trimmed.replace(/^[a-z]+:\/\//i, "");
  const normalized = candidate
    .replace(/\.git$/i, "")
    .replace(/^ssh\//i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();

  return normalized || undefined;
}

function isInternalDirectoryLabel(value?: string): boolean {
  return Boolean(
    value?.startsWith("directory:") || value?.startsWith("workspace:"),
  );
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

function matchCodexChatsRoot(value: string): string | undefined {
  const codexChatsRootMatch = value.match(
    /^(.*[\\/]Documents[\\/]Codex)(?:[\\/]\d{4}-\d{2}-\d{2}(?:[\\/].*)?)?$/,
  );
  return codexChatsRootMatch?.[1];
}

function classifyDirectory(
  directory: LinkedDirectorySummary,
): DirectoryDescriptor {
  // Canonicalize separators up front so a directory keyed via different path
  // representations (Windows `C:\…` vs the forward-slashed `C:/…` we normalize
  // codex/git paths to) collapses to ONE directory row instead of duplicating.
  const path = canonicalizeNavigationPath(directory.path);

  // Match both current ".pwragent" and legacy ".pwragnt" home directory names
  // so pre-rebrand thread data classifies correctly.
  const scratchProjectsRoot = matchScratchProjectsRoot(path);
  if (scratchProjectsRoot) {
    return {
      key: `workspace:${scratchProjectsRoot}`,
      kind: "workspace",
      label: "Workspaces",
      path: scratchProjectsRoot,
    };
  }

  const codexChatsRoot = matchCodexChatsRoot(path);
  if (codexChatsRoot) {
    return {
      key: `directory:${codexChatsRoot}`,
      kind: "directory",
      label: "Codex Chats",
      path: codexChatsRoot,
    };
  }

  const repoWorktreeMatch = path.match(
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

  // Leading `(?:[A-Za-z]:)?` accepts a Windows drive prefix (C:/…); without it
  // the `^[\\/]` anchor only matched POSIX-absolute paths and codex worktrees
  // on Windows fell through to the generic fallback (wrong label, and no
  // chance to group by project name).
  const codexWorktreeMatch = path.match(
    /^(?:[A-Za-z]:)?[\\/].*[\\/]\.codex(?:[\\/]profiles[\\/][^\\/]+)?[\\/]worktrees[\\/][^\\/]+[\\/]([^\\/]+)(?:[\\/].*)?$/,
  );
  if (codexWorktreeMatch) {
    return {
      key: `directory:${path}`,
      kind: "directory",
      label: codexWorktreeMatch[1],
      path,
    };
  }

  return {
    key: `directory:${path}`,
    kind: "directory",
    label: displayDirectoryLabel({
      kind: "directory",
      label: directory.label,
      path,
    }),
    path,
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

function collectManagedWorktreeDescriptorByOrigin(
  threads: NavigationThreadSummary[],
): Map<string, DirectoryDescriptor> {
  const descriptorsByOrigin = new Map<string, DirectoryDescriptor>();

  for (const thread of threads) {
    const origin = normalizeGitOriginUrl(thread.gitOriginUrl);
    if (!origin || descriptorsByOrigin.has(origin)) {
      continue;
    }

    for (const directory of thread.linkedDirectories) {
      const descriptor = classifyDirectory(directory);
      if (!descriptor.path || !isToolManagedWorktreePath(descriptor.path)) {
        continue;
      }
      descriptorsByOrigin.set(origin, descriptor);
      break;
    }
  }

  return descriptorsByOrigin;
}

function normalizeDirectoryDescriptor(
  descriptor: DirectoryDescriptor,
  params: {
    managedWorktreeOriginDescriptor?: DirectoryDescriptor;
    stablePath?: string;
  },
): DirectoryDescriptor {
  if (descriptor.path && isToolManagedWorktreePath(descriptor.path)) {
    if (params.stablePath) {
      return {
        ...descriptor,
        key: `directory:${params.stablePath}`,
        path: params.stablePath,
      };
    }

    return params.managedWorktreeOriginDescriptor ?? descriptor;
  }

  if (
    descriptor.path
    || descriptor.kind !== "directory"
    || !params.stablePath
  ) {
    return descriptor;
  }

  return {
    ...descriptor,
    key: `directory:${params.stablePath}`,
    path: params.stablePath,
  };
}

// INVARIANT: a thread is listed under exactly ONE parent directory row.
// When a thread's linked directories resolve to multiple distinct rows — e.g.
// a tool-managed worktree that couldn't be remapped onto its repo (no stable
// path, no shared git origin), a thread linked to genuinely different repos, or
// a stale backfilled relationship whose path drifted from the live one — we must
// NOT add the thread to every row. Doing so makes the same thread appear (and
// highlight as "selected") under two/three parent folders at once, which the
// product forbids. Pick a single canonical "home" row instead.
//
// Preference order:
//   1. A stable repo/local/workspace row over an ephemeral tool-managed
//      worktree row, so the thread groups under its project (the main checkout)
//      rather than a throwaway worktree folder.
//   2. Existing linked-directory order, so provider/home metadata keeps
//      precedence over user-attached secondary directories until true
//      multi-homed directory listings are implemented.
function pickHomeDirectory(
  descriptors: DirectoryDescriptor[],
): DirectoryDescriptor | undefined {
  if (descriptors.length <= 1) {
    return descriptors[0];
  }

  return descriptors
    .map((descriptor, index) => ({ descriptor, index }))
    .sort((left, right) => {
      const leftDescriptor = left.descriptor;
      const rightDescriptor = right.descriptor;
      const leftIsWorktree = leftDescriptor.path
        ? isToolManagedWorktreePath(leftDescriptor.path)
        : false;
      const rightIsWorktree = rightDescriptor.path
        ? isToolManagedWorktreePath(rightDescriptor.path)
        : false;
      if (leftIsWorktree !== rightIsWorktree) {
        return leftIsWorktree ? 1 : -1;
      }
      return left.index - right.index;
    })[0]?.descriptor;
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

function workspaceRootSet(workspaceRoots?: string[]): Set<string> | undefined {
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
    launchpad.prompt.trim().length > 0
    || (launchpad.imageAttachments?.length ?? 0) > 0
    || launchpad.registeredAt !== undefined
    || launchpad.settingsTouchedAt !== undefined
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
      rootRank.get(normalizeComparablePath(left.path) ?? "")
      ?? Number.MAX_SAFE_INTEGER;
    const rightRootRank =
      rootRank.get(normalizeComparablePath(right.path) ?? "")
      ?? Number.MAX_SAFE_INTEGER;
    if (leftRootRank !== rightRootRank) {
      return leftRootRank - rightRootRank;
    }
  }

  const leftLaunchpadUpdatedAt = left.launchpad?.updatedAt ?? 0;
  const rightLaunchpadUpdatedAt = right.launchpad?.updatedAt ?? 0;
  const launchpadUpdatedDelta =
    rightLaunchpadUpdatedAt - leftLaunchpadUpdatedAt;
  if (launchpadUpdatedDelta !== 0) {
    return launchpadUpdatedDelta;
  }

  const updatedDelta =
    (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0);
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
  const threadKeys = [
    ...new Set(workspaces.flatMap((summary) => summary.threadKeys)),
  ].sort(
    (left, right) =>
      (threadOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (threadOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
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
        (threadOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
        - (threadOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
    ),
  }));
}

export function buildDirectorySummaries(params: {
  threads: NavigationThreadSummary[];
  launchpadsByKey?: Record<string, DirectoryLaunchpadOverlayState | undefined>;
  gitStatusByKey?: Record<string, NavigationDirectoryGitStatus | undefined>;
  /**
   * Per-directory overlay state (currently only carries `pinnedRank`
   * for the Directories-lens pin order). Keyed by the same directory
   * key the snapshot exposes on `NavigationDirectorySummary.key`.
   * Only `kind: "directory"` summaries receive `pinnedRank` from
   * this map — workspace and unlinked pseudo-directories ignore
   * overlay rows even if a misbehaving caller stores one (defense
   * in depth with the IPC handler's validation).
   * See plan: 2026-05-09-002-feat-directory-pinning-plan.md Unit D.
   */
  directoryOverlayByKey?: Record<string, DirectoryOverlayState | undefined>;
  workspaceRoots?: string[];
}): NavigationDirectorySummary[] {
  const summaries = new Map<string, NavigationDirectorySummary>();
  const stablePathByLabel = collectStablePathByLabel(params.threads);
  const managedWorktreeDescriptorByOrigin =
    collectManagedWorktreeDescriptorByOrigin(params.threads);
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
        summary.latestUpdatedAt = Math.max(
          summary.latestUpdatedAt ?? 0,
          thread.updatedAt ?? 0,
        );
      }
      continue;
    }

    // Resolve every linked directory to its normalized row descriptor, deduped
    // by key. A thread linked to the same row via several representations
    // (repo + its own worktree, forward/back slashes, stale backfill) collapses
    // to one entry here.
    const descriptorsByKey = new Map<string, DirectoryDescriptor>();
    for (const directory of thread.linkedDirectories) {
      const descriptor = classifyDirectory(directory);
      const stablePath = stablePathByLabel.get(descriptor.label);
      const origin = normalizeGitOriginUrl(thread.gitOriginUrl);
      const managedWorktreeOriginDescriptor =
        descriptor.path && isToolManagedWorktreePath(descriptor.path) && origin
          ? managedWorktreeDescriptorByOrigin.get(origin)
          : undefined;
      const normalizedDescriptor = normalizeDirectoryDescriptor(descriptor, {
        managedWorktreeOriginDescriptor,
        stablePath,
      });
      if (
        !isAllowedWorkspaceRoot(normalizedDescriptor, allowedWorkspaceRoots)
      ) {
        continue;
      }
      if (!descriptorsByKey.has(normalizedDescriptor.key)) {
        descriptorsByKey.set(normalizedDescriptor.key, normalizedDescriptor);
      }
    }

    // Enforce the one-row-per-thread invariant: even when the descriptors above
    // resolve to multiple distinct rows, the thread is added to exactly one.
    const homeDescriptor = pickHomeDirectory([...descriptorsByKey.values()]);
    if (!homeDescriptor) {
      continue;
    }
    const summary = ensureSummary(summaries, homeDescriptor);
    if (!summary.threadKeys.includes(threadKey)) {
      summary.threadKeys.push(threadKey);
    }
    if (thread.inbox.inInbox) {
      summary.needsAttentionCount += 1;
    }
    summary.latestUpdatedAt = Math.max(
      summary.latestUpdatedAt ?? 0,
      thread.updatedAt ?? 0,
    );
  }

  for (const [directoryKey, launchpad] of Object.entries(
    params.launchpadsByKey ?? {},
  )) {
    if (!launchpad || !hasPersistableLaunchpadState(launchpad)) {
      continue;
    }
    const launchpadPath =
      launchpad.directoryPath ?? pathFromDirectoryKey(directoryKey);
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
    summary.latestUpdatedAt = Math.max(
      summary.latestUpdatedAt ?? 0,
      launchpad.updatedAt,
    );
  }

  for (const [directoryKey, gitStatus] of Object.entries(
    params.gitStatusByKey ?? {},
  )) {
    if (!gitStatus) {
      continue;
    }
    const summary = summaries.get(directoryKey);
    if (summary) {
      summary.gitStatus = gitStatus;
    }
  }

  // Directory pin overlay (Unit D). Attach `pinnedRank` to
  // `kind: "directory"` AND `kind: "workspace"` summaries — both
  // are named entries the user explicitly browses by clicking. The
  // `unlinked` bucket is a synthetic roll-up of threads with no
  // linked directory and isn't user-pinnable, so we skip it here
  // even though the IPC handler also rejects pinning that key.
  for (const [directoryKey, overlay] of Object.entries(
    params.directoryOverlayByKey ?? {},
  )) {
    if (!overlay?.pinnedRank) {
      continue;
    }
    const summary = summaries.get(directoryKey);
    if (
      summary
      && (summary.kind === "directory" || summary.kind === "workspace")
    ) {
      summary.pinnedRank = overlay.pinnedRank;
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
