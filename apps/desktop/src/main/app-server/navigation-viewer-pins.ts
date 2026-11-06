import { buildFederatedThreadRef, buildThreadIdentityKey, federatedThreadIdentityKey,
  findRemoteHomeDirectoryIndex, remoteThreadPlaceholderDirectory } from "@pwragent/shared";
import type { FederationRemoteTarget, NavigationDirectorySummary, NavigationIdentity,
  NavigationThreadSummary } from "@pwragent/shared";
import type { NavigationQueryIndex } from "@pwragent/owner-core/navigation-query-projection";
import type { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";
import type { DesktopOwnerStorage } from "../storage/desktop-overlay-store";

/** Resolve compact viewer membership through the live owner cache, without awaiting a peer. */
export async function loadViewerNavigationPins(
  store: Pick<DesktopOwnerStorage, "readRemoteThreadPinNavigationRows" | "updateRemoteThreadPinSnapshots" | "removeRemoteThreadPin">,
  cache: Pick<RemoteThreadSummaryCache, "resolvePinnedThreads">,
): Promise<NavigationThreadSummary[]> {
  const saved = await store.readRemoteThreadPinNavigationRows();
  const pins = saved.flatMap((summary) => summary.federation ? [{
    ref: summary.federation.ref, instanceLabel: summary.federation.instanceLabel,
    addedAt: 0, summary, localPinnedRank: summary.pinnedRank,
  }] : []);
  const resolved = await cache.resolvePinnedThreads(pins);
  for (const ref of resolved.archived) await store.removeRemoteThreadPin({ ref });
  await store.updateRemoteThreadPinSnapshots(resolved.refreshed);
  const ranks = new Map(pins.map((pin) => [federatedThreadIdentityKey(pin.ref), pin.localPinnedRank]));
  return resolved.threads.map(({ pinnedRank: _ownerRank, ...thread }) => {
    const rank = thread.federation ? ranks.get(federatedThreadIdentityKey(thread.federation.ref)) : undefined;
    return rank ? { ...thread, pinnedRank: rank } : thread;
  });
}

/**
 * Rows for peer threads an exact viewer read names without pinning them, such
 * as another instance's drafts. The summary cache holds them beside the pins
 * and never waits on a peer; a pinned identity is already in `pins`.
 */
export function loadViewerWatchedNavigationRows(
  cache: Pick<RemoteThreadSummaryCache, "resolveWatchedThreads">,
  identities: readonly NavigationIdentity[],
  pins: readonly NavigationThreadSummary[],
): NavigationThreadSummary[] {
  const pinned = new Set(pins.flatMap((pin) => pin.federation ? [federatedThreadIdentityKey(pin.federation.ref)] : []));
  const refs = identities.flatMap((identity) => identity.ownerInstanceId ? [buildFederatedThreadRef({
    backend: identity.backend, instanceId: identity.ownerInstanceId, threadId: identity.threadId,
  })] : []).filter((ref) => !pinned.has(federatedThreadIdentityKey(ref)));
  if (!refs.length) return [];
  // An owner's pin order is not this viewer's; only a viewer pin ranks a row here.
  return cache.resolveWatchedThreads(refs).flatMap(({ pinnedRank: _ownerRank, ...thread }) =>
    thread.federation && !pinned.has(federatedThreadIdentityKey(thread.federation.ref)) ? [thread] : []);
}

/** Viewer-owned remote memberships use the same project grouping as the established sidebar. */
export function appendViewerNavigationPins(index: NavigationQueryIndex, pins: readonly NavigationThreadSummary[]): NavigationQueryIndex {
  return { ...index, directories: attachRemoteThreadsToLocalDirectories(index.directories, [...pins]),
    threads: [...index.threads, ...pins] };
}

/**
 * One placeholder can hold threads from two repositories that share a
 * folder name. It then stands for both, so a peer with either counts as
 * having the project. A thread whose owner sent no identity adds nothing:
 * it cannot say which repository it is in.
 */
function mergePlaceholderRepositories(
  existing: NavigationDirectorySummary,
  incoming: NavigationDirectorySummary,
): NavigationDirectorySummary {
  const incomingRepositories = repositoriesOf(incoming);
  if (!incomingRepositories.length) return existing;
  const existingRepositories = repositoriesOf(existing);
  if (!existingRepositories.length) {
    return {
      ...existing,
      ...(incoming.repositoryKey ? { repositoryKey: incoming.repositoryKey } : {}),
      ...(incoming.repositoryKeys ? { repositoryKeys: incoming.repositoryKeys } : {}),
    };
  }
  const added = incomingRepositories.filter((repository) => !existingRepositories.includes(repository));
  return added.length
    ? { ...existing, repositoryKeys: [...existing.repositoryKeys ?? [], ...added] }
    : existing;
}

function repositoriesOf(directory: NavigationDirectorySummary): string[] {
  return [directory.repositoryKey, ...directory.repositoryKeys ?? []]
    .filter((repository): repository is string => Boolean(repository));
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
 * when it identifies a linked directory; otherwise both sides share
 * `orderByHomePreference`.
 *
 * Remote threads whose project has no local counterpart receive an
 * unconfigured placeholder group. That keeps Cmd+K-mounted rows discoverable
 * in the Directories lens until Add Directory registers a matching checkout.
 */
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
  const placeholderThreads = new Map<number, NavigationThreadSummary[]>();
  for (const thread of remoteThreads) {
    const threadKey = thread.federation?.ref
      ? federatedThreadIdentityKey(thread.federation.ref)
      : buildThreadIdentityKey(thread.source, thread.id);
    let homeIndex = findRemoteHomeDirectoryIndex(
      mergedDirectories,
      thread,
    );
    if (homeIndex === undefined) {
      const placeholder = remoteThreadPlaceholderDirectory(thread);
      if (!placeholder) {
        continue;
      }
      homeIndex = mergedDirectories.findIndex(
        (directory) => directory.key === placeholder.key,
      );
      if (homeIndex === -1) {
        homeIndex = mergedDirectories.push(placeholder) - 1;
      }
    } else if (mergedDirectories[homeIndex]!.localAvailability === "unconfigured") {
      // A later thread finds an earlier thread's placeholder by name. Only
      // its home project's identity belongs there: a secondary link's name
      // can match too, and the home repository is a different project.
      const placeholder = remoteThreadPlaceholderDirectory(thread);
      if (placeholder?.key === mergedDirectories[homeIndex]!.key) {
        mergedDirectories[homeIndex] = mergePlaceholderRepositories(mergedDirectories[homeIndex]!, placeholder);
      }
    }
    // Every member counts, including one that found the placeholder by
    // name after an earlier thread created it.
    if (mergedDirectories[homeIndex]?.localAvailability === "unconfigured") {
      const members = placeholderThreads.get(homeIndex) ?? [];
      members.push(thread);
      placeholderThreads.set(homeIndex, members);
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
    const peerProject = placeholderPeerProject(directory, placeholderThreads.get(index));
    return {
      ...directory,
      ...peerProject,
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


/**
 * The one peer project a placeholder's threads live in, with that project's
 * Forge Automation as its owner reported it on the rows. None when the
 * threads come from more than one peer or project, or no row names its
 * project (an owner that predates `homeProject`): the row then shows no
 * setting rather than one that covers only some of its threads.
 */
function placeholderPeerProject(
  directory: NavigationDirectorySummary,
  threads: readonly NavigationThreadSummary[] | undefined,
): Pick<NavigationDirectorySummary, "peerProject" | "forgeAutomation"> {
  if (directory.kind !== "directory" || directory.localAvailability !== "unconfigured" || !threads?.length) {
    return {};
  }
  let target: FederationRemoteTarget | undefined;
  let home: NavigationThreadSummary["homeProject"];
  for (const thread of threads) {
    const owner = thread.federation?.ref.target;
    if (owner?.scope !== "remote" || (target && owner.instanceId !== target.instanceId)) return {};
    target ??= owner;
    if (!thread.homeProject) continue;
    if (home && home.directoryKey !== thread.homeProject.directoryKey) return {};
    home ??= thread.homeProject;
  }
  if (!target || !home) return {};
  return {
    peerProject: { target: { scope: "remote", instanceId: target.instanceId }, directoryKey: home.directoryKey },
    ...(home.forgeAutomation ? { forgeAutomation: home.forgeAutomation } : {}),
  };
}
