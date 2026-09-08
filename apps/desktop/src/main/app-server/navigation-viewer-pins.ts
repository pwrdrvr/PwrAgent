import path from "node:path";
import { buildThreadIdentityKey, federatedThreadIdentityKey } from "@pwragent/shared";
import type { LinkedDirectorySummary, NavigationDirectorySummary, NavigationThreadSummary } from "@pwragent/shared";
import type { NavigationQueryIndex } from "./navigation-query-projection";

/** Viewer-owned remote memberships use the same project grouping as the established sidebar. */
export function appendViewerNavigationPins(index: NavigationQueryIndex, pins: readonly NavigationThreadSummary[]): NavigationQueryIndex {
  return { ...index, directories: attachRemoteThreadsToLocalDirectories(index.directories, [...pins]),
    threads: [...index.threads, ...pins] };
}

/**
 * Consolidate pinned remote threads into the LOCAL project groups they
 * correspond to, so the Directories lens shows them and the title-bar
 * breadcrumb (selectedDirectory resolves by threadKeys membership) carries
 * the project name. Peer paths never match viewer paths, so matching is by
 * project identity: the linked directory's label, or its path basename.
 *
 * Mirrors `buildDirectorySummaries`' one-row-per-thread invariant
 * (`pickHomeDirectory`): a multi-directory thread joins exactly ONE local
 * group — its home directory — never every group it can match. Duplicating
 * the row made selection "jump" groups, because `selectedDirectory` resolves
 * to the first directory containing the key, which is whichever sorts first,
 * not the group the user clicked in. The owner's `projectKey` is authoritative
 * when it identifies a linked directory; fallback preference is a local
 * checkout before a worktree, then linked-directory order.
 *
 * Remote threads whose project has no local counterpart receive an
 * unconfigured placeholder group. That keeps Cmd+K-mounted rows discoverable
 * in the Directories lens until Add Directory registers a matching checkout.
 */
/**
 * The single local directory group a remote thread belongs to, by project
 * identity (directory label / path basename — peer paths never match viewer
 * paths). When the owner's projectKey identifies one of its linked
 * directories, that primary project wins even if a secondary @-referenced
 * directory is a local checkout. Otherwise, home preference mirrors
 * `pickHomeDirectory`: repo checkouts (`kind: "local"`) before worktree
 * links, then the owner's linked order.
 */
export function findRemoteHomeDirectoryIndex(
  directories: ReadonlyArray<{ label: string; path?: string }>,
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "projectKey">,
): number | undefined {
  const directoryIndexByName = new Map<string, number>();
  directories.forEach((directory, index) => {
    const names = new Set(
      [directory.label, directory.path ? path.basename(directory.path) : ""]
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    );
    for (const name of names) {
      if (!directoryIndexByName.has(name)) {
        directoryIndexByName.set(name, index);
      }
    }
  });
  const linkedByHomePreference = remoteLinkedDirectoriesByHomePreference(thread);
  for (const linked of linkedByHomePreference) {
    const names = [linked.label, path.basename(linked.path)]
      .map((name) => (name ?? "").trim().toLowerCase())
      .filter(Boolean);
    for (const name of names) {
      const index = directoryIndexByName.get(name);
      if (index !== undefined) {
        return index;
      }
    }
  }
  return undefined;
}

function remoteLinkedDirectoriesByHomePreference(
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "projectKey">,
): LinkedDirectorySummary[] {
  const linkedDirectories = thread.linkedDirectories ?? [];
  const projectKey = thread.projectKey;
  const primaryProjectDirectory = projectKey
    ? linkedDirectories.find((directory) =>
        linkedDirectoryMatchesProjectKey(directory, projectKey)
      )
    : undefined;
  if (primaryProjectDirectory) {
    return [primaryProjectDirectory];
  }

  return [...linkedDirectories].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "worktree" ? 1 : -1;
    }
    return 0;
  });
}

function remoteDirectoryPlaceholder(
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "projectKey">,
): NavigationDirectorySummary | undefined {
  const home = remoteLinkedDirectoriesByHomePreference(thread)[0];
  if (!home) {
    return undefined;
  }
  const label = home.label.trim() || path.basename(home.path).trim();
  if (!label) {
    return undefined;
  }

  return {
    key: `unconfigured-directory:${encodeURIComponent(label.toLowerCase())}`,
    kind: "directory",
    label,
    localAvailability: "unconfigured",
    threadKeys: [],
    needsAttentionCount: 0,
  };
}

function linkedDirectoryMatchesProjectKey(
  directory: Pick<LinkedDirectorySummary, "path" | "worktreePath">,
  projectKey: string,
): boolean {
  const normalizedProjectKey = normalizeFederatedPath(projectKey);
  if (!normalizedProjectKey) {
    return false;
  }
  return [directory.path, directory.worktreePath].some(
    (candidate) => normalizeFederatedPath(candidate) === normalizedProjectKey,
  );
}

function normalizeFederatedPath(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || undefined;
}

export function attachRemoteThreadsToLocalDirectories(
  directories: NavigationDirectorySummary[],
  remoteThreads: NavigationThreadSummary[],
): NavigationDirectorySummary[] {
  if (remoteThreads.length === 0) {
    return directories;
  }
  const mergedDirectories = [...directories];
  const addedByDirectoryIndex = new Map<
    number,
    Array<{ threadKey: string; inInbox: boolean }>
  >();
  for (const thread of remoteThreads) {
    const threadKey = thread.federation?.ref
      ? federatedThreadIdentityKey(thread.federation.ref)
      : buildThreadIdentityKey(thread.source, thread.id);
    let homeIndex = findRemoteHomeDirectoryIndex(
      mergedDirectories,
      thread,
    );
    if (homeIndex === undefined) {
      const placeholder = remoteDirectoryPlaceholder(thread);
      if (!placeholder) {
        continue;
      }
      homeIndex = mergedDirectories.findIndex(
        (directory) => directory.key === placeholder.key,
      );
      if (homeIndex === -1) {
        homeIndex = mergedDirectories.push(placeholder) - 1;
      }
    }
    const added = addedByDirectoryIndex.get(homeIndex) ?? [];
    added.push({ threadKey, inInbox: Boolean(thread.inbox?.inInbox) });
    addedByDirectoryIndex.set(homeIndex, added);
  }
  if (addedByDirectoryIndex.size === 0) {
    return directories;
  }
  return mergedDirectories.map((directory, index) => {
    const added = addedByDirectoryIndex
      .get(index)
      ?.filter((entry) => !directory.threadKeys.includes(entry.threadKey));
    if (!added?.length) {
      return directory;
    }
    return {
      ...directory,
      threadKeys: [
        ...directory.threadKeys,
        ...added.map((entry) => entry.threadKey),
      ],
      // Unread remote rows count toward the group's "N to review" badge
      // just like local rows do.
      needsAttentionCount:
        directory.needsAttentionCount
        + added.filter((entry) => entry.inInbox).length,
    };
  });
}

