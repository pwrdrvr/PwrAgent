import type { DirectorySummaryKind, NavigationDirectoryGitStatus, NavigationDirectorySummary, NavigationThreadSummary } from "./contracts/navigation";
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
  checkoutPaths?: readonly string[];
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
export function directoryIdentityNames(directory: { label: string; path?: string; kind?: string; checkoutPaths?: readonly string[] }): string[] {
  const basenames = [directory.path, ...directory.checkoutPaths ?? []].map((path) => path?.split(/[\\/]/).filter(Boolean).pop() ?? "");
  return [...new Set(
    [directory.label, ...basenames]
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
  const localNames = directoryIdentityNames(local);
  const choose = (matches: readonly T[]): T | undefined => {
    if (matches.length <= 1) return matches[0];
    // Only the owner can fold linked worktrees into a primary checkout.
    // Distinct rows must be compared without interpreting the owner's paths.
    for (const name of localNames) {
      const named = matches.filter((directory) => directory.label.trim().toLowerCase() === name);
      if (named.length === 1) return named[0];
    }
    const grouped = matches.filter((directory) => directory.checkoutPaths?.length);
    return grouped.length === 1 ? grouped[0] : undefined;
  };
  const localRepository = local.repositoryKey?.toLowerCase();
  if (localRepository) {
    const byRepository = candidates.filter(
      (directory) => directory.repositoryKey?.toLowerCase() === localRepository,
    );
    if (byRepository.length) {
      return choose(byRepository);
    }
  }
  const localRepositories = repositoryIdentities(local);
  if (localRepositories.length) {
    const byRemote = candidates.filter((directory) =>
      repositoryIdentities(directory).some((repository) => localRepositories.includes(repository)),
    );
    if (byRemote.length) {
      return choose(byRemote);
    }
  }
  const nameCandidates = localRepositories.length
    ? candidates.filter((directory) => repositoryIdentities(directory).length === 0)
    : candidates;
  // A label match beats a basename match, so a peer that has both "PwrAgnt"
  // the project and some other checkout whose folder happens to be named
  // "pwragnt" lands on the project.
  for (const name of localNames) {
    const byLabel = nameCandidates.filter(
      (directory) => directory.label.trim().toLowerCase() === name,
    );
    if (byLabel.length) {
      return choose(byLabel);
    }
  }
  return choose(nameCandidates.filter((directory) =>
    directoryIdentityNames(directory).some((name) => localNames.includes(name)),
  ));
}

function repositoryIdentities(directory: ProjectRepositoryIdentity): string[] {
  return [directory.repositoryKey, ...directory.repositoryKeys ?? []]
    .filter((repository): repository is string => Boolean(repository))
    .map((repository) => repository.toLowerCase());
}

function rememberHomeNames(names: Map<string, number>, directories: readonly RemoteHomeCandidate[], index: number,
  labels = directoryIdentityNames(directories[index]!)): void {
  const directory = directories[index]!;
  for (const name of labels) {
    const current = names.get(name);
    if (current === undefined || compareHomeCandidates(directory, directories[current]!, name) < 0) names.set(name, index);
  }
}

function matchCheckoutHome(home: LinkedDirectorySummary, directories: readonly RemoteHomeCandidate[], positions?: number[]): number | undefined {
  const candidate = (directory: RemoteHomeCandidate, index: number) => directory.kind === "directory" ? [{
    ...directory, kind: directory.kind, index,
    repositoryKey: directory.gitStatus?.originRepository ?? directory.repositoryKey,
    repositoryKeys: directory.gitStatus?.remoteRepositories ?? directory.repositoryKeys,
  }] : [];
  const candidates = positions ? positions.flatMap((index) => candidate(directories[index]!, index)) : directories.flatMap(candidate);
  return findPeerCounterpartDirectory({ ...home, kind: "directory" }, candidates)?.index;
}

/** One lookup for a batch of mounted pins. Newly created placeholders can win
 * legacy name matches, but only configured directories can match a checkout. */
export function indexRemoteHomeDirectories(directories: readonly RemoteHomeCandidate[]) {
  const names = new Map<string, number>();
  const byKey = new Map<string, number>();
  const checkoutNames = new Map<string, number[]>();
  const repositories = new Map<string, number[]>();
  const checkoutMatches = new Map<string, number | undefined>();
  let workspace: number | undefined;
  function append(index: number): void {
    const directory = directories[index]!;
    const labels = directoryIdentityNames(directory);
    rememberHomeNames(names, directories, index, labels);
    if (!byKey.has(directory.key)) byKey.set(directory.key, index);
    if (directory.kind === "workspace") workspace ??= index;
    if (directory.kind !== "directory" || directory.localAvailability === "unconfigured") return;
    checkoutMatches.clear();
    const add = (map: Map<string, number[]>, key: string) => {
      const matches = map.get(key);
      if (matches) matches.push(index);
      else map.set(key, [index]);
    };
    for (const name of labels) add(checkoutNames, name);
    for (const repo of repositoryIdentities({ repositoryKey: directory.gitStatus?.originRepository ?? directory.repositoryKey,
      repositoryKeys: directory.gitStatus?.remoteRepositories ?? directory.repositoryKeys })) add(repositories, repo);
  }
  directories.forEach((_, i) => append(i));
  return { append, byKey, names, get workspace() { return workspace; },
    findCheckout(home: LinkedDirectorySummary): number | undefined {
      const key = JSON.stringify([home.label, home.path, home.repositoryKey, home.repositoryKeys]);
      if (checkoutMatches.has(key)) return checkoutMatches.get(key);
      const matches = repositoryIdentities(home).flatMap((repo) => repositories.get(repo) ?? []);
      const positions = new Set(matches.length ? matches : directoryIdentityNames(home).flatMap((name) => checkoutNames.get(name) ?? []));
      const index = matchCheckoutHome(home, directories, [...positions]);
      checkoutMatches.set(key, index);
      return index;
    },
  };
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
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "projectKey" | "checkoutProject">,
  lookup?: ReturnType<typeof indexRemoteHomeDirectories>,
): number | undefined {
  // Scratch folder names are per-thread identities, not project identities.
  // Match the containing workspace by kind before considering any raw names.
  const linkedByHomePreference = remoteLinkedDirectoriesByHomePreference(thread);
  const home = linkedByHomePreference[0];
  if (home && thread.checkoutProject) {
    return lookup ? lookup.findCheckout(home) : matchCheckoutHome(home, directories);
  }
  if (home && classifyDirectory(home).kind === "workspace") {
    if (lookup) return lookup.workspace;
    const index = directories.findIndex((directory) => directory.kind === "workspace");
    return index === -1 ? undefined : index;
  }
  // Two rows can answer to one name: a checkout and a tool-managed worktree
  // of it, or two clones. Main files a row from its own list and the
  // renderer places a starting row from the list it rendered, and the two
  // are not in one order, so the first match is not one answer. The winner
  // is chosen by what the rows are instead.
  const directoryIndexByName = lookup?.names ?? new Map<string, number>();
  if (!lookup) directories.forEach((_, index) => rememberHomeNames(directoryIndexByName, directories, index));
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
export type RemoteHomeCandidate = ProjectRepositoryIdentity & {
  key: string;
  label: string;
  path?: string;
  checkoutPaths?: readonly string[];
  gitStatus?: Pick<NavigationDirectoryGitStatus, "originRepository" | "remoteRepositories">;
  kind?: DirectorySummaryKind;
  localAvailability?: "unconfigured";
};

/**
 * The placeholder project main adds for a remote thread whose project has no
 * local row, so the Directories lens still shows it until Add Directory
 * registers a matching checkout. The renderer draws the same row under a
 * peer's starting thread, so the thread lands where it started.
 */
export function remoteThreadPlaceholderDirectory(
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "projectKey" | "checkoutProject">,
): NavigationDirectorySummary | undefined {
  const home = remoteLinkedDirectoriesByHomePreference(thread)[0];
  if (!home) {
    return undefined;
  }
  const descriptor = classifyDirectory(home);
  if (descriptor.kind === "workspace") {
    // Never expose a peer path as a launchable local directory. All remote
    // scratch mounts share this group until a local Workspaces row exists.
    return {
      key: "unconfigured-workspace",
      kind: "workspace",
      label: descriptor.label,
      localAvailability: "unconfigured",
      threadKeys: [],
      needsAttentionCount: 0,
    };
  }
  const label = home.label.trim() || (home.path.split(/[\\/]/).filter(Boolean).pop() ?? "").trim();
  if (!label) {
    return undefined;
  }

  // The key stays name-based so existing rows keep their grouping. The
  // owner's repository identity rides along, so the row's New chat menu
  // matches peers by origin rather than by folder name alone.
  return {
    key: `unconfigured-directory:${encodeURIComponent(label.toLowerCase())}`,
    kind: "directory",
    label,
    localAvailability: "unconfigured",
    ...(home.repositoryKey ? { repositoryKey: home.repositoryKey } : {}),
    ...(home.repositoryKeys?.length ? { repositoryKeys: [...home.repositoryKeys] } : {}),
    threadKeys: [],
    needsAttentionCount: 0,
  };
}

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
function remoteLinkedDirectoriesByHomePreference(
  thread: Pick<NavigationThreadSummary, "linkedDirectories" | "projectKey" | "checkoutProject">,
): LinkedDirectorySummary[] {
  if (thread.checkoutProject) {
    const { key, label, repositoryKey } = thread.checkoutProject;
    return [{ id: key, label, path: key.slice("directory:".length), kind: "local", repositoryKey }];
  }
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
