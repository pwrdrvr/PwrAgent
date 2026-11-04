import type { DirectorySummaryKind, NavigationThreadSummary } from "./contracts/navigation";
import type { LinkedDirectorySummary } from "./contracts/normalized-app-server";
import { classifyDirectory, orderByHomePreference } from "./directory-navigation";
import { isToolManagedWorktreePath } from "./worktree-paths";

/** A checkout's repository, as every machine names it. */
export type ProjectRepositoryIdentity = {
  /** `host/owner/repo` from the checkout's origin, when the owner read one. */
  repositoryKey?: string;
  /** Normalized configured fetch remotes, including fork and upstream. */
  repositoryKeys?: readonly string[];
};

/** What it takes to recognize one project on two machines. */
export type ProjectIdentity = ProjectRepositoryIdentity & {
  kind: DirectorySummaryKind;
  label: string;
  path?: string;
};

type PeerDirectory = ProjectIdentity & {
  localAvailability?: "unconfigured";
};

/**
 * Names a directory answers to across machines: its label and its path's
 * last segment, folded to lower case. Peer paths never equal viewer paths
 * (different home directories, `C:\…` against `/Users/…`), so without an
 * origin to compare, project identity falls back to name — the same rule main
 * uses to file a remote thread under a local project group
 * (`findRemoteHomeDirectoryIndex`).
 */
export function directoryIdentityNames(directory: { label: string; path?: string; kind?: string }): string[] {
  const basename = directory.path?.split(/[\\/]/).filter(Boolean).pop();
  return [...new Set(
    [directory.label, basename ?? ""]
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  )];
}

/**
 * The peer's counterpart of a local directory row, or undefined when the peer
 * has no such project.
 *
 * The directory-less Workspaces row maps onto the peer's own Workspaces row:
 * scratch folders are per-thread, so there is nothing to match. A real
 * project only matches a real project — never the peer's Workspaces or
 * unlinked rows, and never a placeholder the peer derived from someone else's
 * thread without a checkout of its own.
 *
 * The checkout's origin decides first: `~/pwrdrvr/PwrAgnt` here and
 * `C:\src\PwrAgent` there are one project when both clone
 * `github.com/pwrdrvr/pwragent`, whatever their folders are called. Two
 * different origins can share a configured fetch remote, as a fork and its
 * upstream do. With no shared remote, two known repositories never match by
 * name. Only when either side has no repository metadata does the name decide.
 */
export function findPeerCounterpartDirectory<T extends PeerDirectory>(
  local: ProjectIdentity,
  peerDirectories: readonly T[],
): T | undefined {
  if (local.kind === "workspace") {
    return peerDirectories.find((directory) => directory.kind === "workspace");
  }
  const candidates = peerDirectories.filter(
    (directory) =>
      directory.kind === "directory"
      && directory.localAvailability !== "unconfigured",
  );
  const localRepository = local.repositoryKey?.toLowerCase();
  if (localRepository) {
    const byRepository = candidates.find(
      (directory) => directory.repositoryKey?.toLowerCase() === localRepository,
    );
    if (byRepository) {
      return byRepository;
    }
  }
  const localRepositories = repositoryIdentities(local);
  if (localRepositories.length) {
    const byRemote = candidates.find((directory) =>
      repositoryIdentities(directory).some((repository) => localRepositories.includes(repository)),
    );
    if (byRemote) {
      return byRemote;
    }
  }
  const nameCandidates = localRepositories.length
    ? candidates.filter((directory) => repositoryIdentities(directory).length === 0)
    : candidates;
  const localNames = directoryIdentityNames(local);
  // A label match beats a basename match, so a peer that has both "PwrAgnt"
  // the project and some other checkout whose folder happens to be named
  // "pwragnt" lands on the project.
  for (const name of localNames) {
    const byLabel = nameCandidates.find(
      (directory) => directory.label.trim().toLowerCase() === name,
    );
    if (byLabel) {
      return byLabel;
    }
  }
  return nameCandidates.find((directory) =>
    directoryIdentityNames(directory).some((name) => localNames.includes(name)),
  );
}

function repositoryIdentities(directory: ProjectIdentity): string[] {
  return [directory.repositoryKey, ...directory.repositoryKeys ?? []]
    .filter((repository): repository is string => Boolean(repository))
    .map((repository) => repository.toLowerCase());
}

/**
 * The single local directory group a remote thread belongs to, by project
 * identity (directory label / path basename — peer paths never match viewer
 * paths). When the owner's projectKey identifies one of its linked
 * directories, that primary project wins even if a secondary @-referenced
 * directory is a local checkout. Otherwise, home preference is the owner's
 * own rule (`orderByHomePreference`): tool-managed worktree folders last,
 * otherwise linked order.
 *
 * Main files every peer row in the Directories lens with this rule, and the
 * renderer places a peer thread's starting row with it, so the row the
 * thread lands in is the row it started in.
 */
export function findRemoteHomeDirectoryIndex(
  directories: ReadonlyArray<RemoteHomeCandidate>,
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "projectKey">,
): number | undefined {
  // Scratch folder names are per-thread identities, not project identities.
  // Match the containing workspace by kind before considering any raw names.
  const linkedByHomePreference = remoteLinkedDirectoriesByHomePreference(thread);
  const home = linkedByHomePreference[0];
  if (home && classifyDirectory(home).kind === "workspace") {
    const index = directories.findIndex((directory) => directory.kind === "workspace");
    return index === -1 ? undefined : index;
  }
  // Two rows can answer to one name: a checkout and a tool-managed worktree
  // of it, or two clones. Main files a row from its own list and the
  // renderer places a starting row from the list it rendered, and the two
  // are not in one order, so the first match is not one answer. The winner
  // is chosen by what the rows are instead.
  const directoryIndexByName = new Map<string, number>();
  directories.forEach((directory, index) => {
    for (const name of directoryIdentityNames(directory)) {
      const current = directoryIndexByName.get(name);
      if (current === undefined || compareHomeCandidates(directory, directories[current]!, name) < 0) {
        directoryIndexByName.set(name, index);
      }
    }
  });
  for (const linked of linkedByHomePreference) {
    // A secondary Workspaces link is matched by kind only when it is home.
    // Its folder name (`projects`, a scratch hash) names no project, and a
    // name match would file the thread under Workspaces whenever its real
    // project has no local checkout.
    if (classifyDirectory(linked).kind === "workspace") {
      continue;
    }
    for (const name of directoryIdentityNames(linked)) {
      const index = directoryIndexByName.get(name);
      if (index !== undefined) {
        return index;
      }
    }
  }
  return undefined;
}

/** A local directory row a remote thread can be filed under. */
export type RemoteHomeCandidate = {
  key: string;
  label: string;
  path?: string;
  kind?: DirectorySummaryKind;
  localAvailability?: "unconfigured";
};

// Below zero when `a` is the better home for a thread named `name`: a
// configured row before a placeholder, a checkout before a tool-managed
// worktree folder, a label match before a folder-name match, then by key.
function compareHomeCandidates(a: RemoteHomeCandidate, b: RemoteHomeCandidate, name: string): number {
  const rank = (directory: RemoteHomeCandidate): number[] => [
    directory.localAvailability === "unconfigured" ? 1 : 0,
    isToolManagedWorktreePath(directory.path) ? 1 : 0,
    directory.label.trim().toLowerCase() === name ? 0 : 1,
  ];
  const rankA = rank(a);
  const rankB = rank(b);
  for (let index = 0; index < rankA.length; index += 1) {
    if (rankA[index] !== rankB[index]) return rankA[index]! - rankB[index]!;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** A remote thread's linked directories, home first. */
export function remoteLinkedDirectoriesByHomePreference(
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

  return orderByHomePreference(linkedDirectories, (directory) => classifyDirectory(directory).path);
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
