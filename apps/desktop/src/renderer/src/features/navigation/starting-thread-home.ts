import {
  findRemoteHomeDirectoryIndex,
  isRemoteFederationTarget,
  remoteThreadPlaceholderDirectory,
  type FederationRemoteTarget,
  type FederationTarget,
  type NavigationDirectorySummary,
  type NavigationLaunchpadDraft,
  type NavigationThreadSummary,
} from "@pwragent/shared";

/** What a starting row carries that decides where it renders. */
export type StartingThreadPlacement = {
  directoryKey: string;
  directoryLabel: string;
  launchpad: Pick<NavigationLaunchpadDraft, "directoryPath">;
  parentThreadKey?: string;
  target?: FederationTarget;
};

type HomeCandidate = Pick<NavigationDirectorySummary, "key" | "kind" | "label" | "localAvailability" | "path">;

/**
 * Whether main files this starting thread by `findRemoteHomeDirectoryIndex`:
 * a peer's root thread in this machine's list. A federation window shows the
 * peer's own list, where the launchpad's key is the thread's row, and a
 * sub-thread lands under its parent's row, not a project's.
 */
function isPeerThreadInLocalList(
  creation: StartingThreadPlacement,
  windowTarget: FederationRemoteTarget | undefined,
): boolean {
  return Boolean(creation.target
    && isRemoteFederationTarget(creation.target)
    && creation.target.instanceId !== windowTarget?.instanceId
    && !creation.parentThreadKey);
}

/**
 * A peer's thread as its owner will report it, as far as its home goes.
 *
 * Every backend reports the thread's working directory as `projectKey`, and
 * the home rule then reads only the linked directory it names: the
 * launchpad's directory, or its worktree. `@`-referenced directories link
 * after the thread starts and never change the home, so they are left out.
 */
function startingPeerThread(
  creation: StartingThreadPlacement,
): Pick<NavigationThreadSummary, "linkedDirectories" | "projectKey"> {
  const keyPath = /^(?:directory|workspace):(.+)$/.exec(creation.directoryKey)?.[1] ?? "";
  const path = creation.launchpad.directoryPath?.trim() || keyPath;
  if (!path) return { linkedDirectories: [] };
  return {
    linkedDirectories: [{ id: creation.directoryKey, kind: "local", label: creation.directoryLabel, path }],
    projectKey: path,
  };
}

/**
 * The project row a starting thread lands in: the row its thread's row will
 * render in, so the starting row never moves when the thread arrives.
 *
 * A thread on the machine whose list this is lands in its launchpad's own
 * row. A peer's thread in this machine's list does not: its launchpad names
 * the peer's directory, keyed by the peer's path, and main files the thread
 * under a local project by `findRemoteHomeDirectoryIndex`. The starting row
 * asks that rule about the directories the thread will link, even when the
 * peer's path happens to equal a local one, because main does too.
 *
 * Undefined when no project row will take it: a sub-thread whose parent row
 * is not here, or a peer thread with nothing to link.
 */
export function startingThreadHomeDirectoryKey(
  creation: StartingThreadPlacement,
  directories: readonly HomeCandidate[],
  /** The peer a federation window shows; absent in this machine's window. */
  windowTarget?: FederationRemoteTarget,
): string | undefined {
  if (!isPeerThreadInLocalList(creation, windowTarget)) {
    return directories.some((directory) => directory.key === creation.directoryKey)
      ? creation.directoryKey
      : undefined;
  }
  const index = findRemoteHomeDirectoryIndex(directories, startingPeerThread(creation));
  return index === undefined ? undefined : directories[index]!.key;
}

/**
 * The list with the placeholder project each starting peer thread will
 * create. Main adds a placeholder row, at the end of the list, for a peer's
 * thread whose project has no row here. Drawing it while the thread starts
 * puts the starting row where its thread lands. Once the thread lands, main's
 * own placeholder has the same key and this one steps aside.
 */
export function withStartingPlaceholderDirectories<Directory extends HomeCandidate>(
  directories: readonly Directory[],
  creations: readonly StartingThreadPlacement[] | undefined,
  windowTarget: FederationRemoteTarget | undefined,
  /** The list's own row for main's placeholder summary. */
  toDirectory: (placeholder: NavigationDirectorySummary) => Directory,
): readonly Directory[] {
  let merged: Directory[] | undefined;
  for (const creation of creations ?? []) {
    if (!isPeerThreadInLocalList(creation, windowTarget)) continue;
    const current = merged ?? directories;
    if (startingThreadHomeDirectoryKey(creation, current, windowTarget)) continue;
    const placeholder = remoteThreadPlaceholderDirectory(startingPeerThread(creation));
    if (!placeholder || current.some((directory) => directory.key === placeholder.key)) continue;
    merged = [...current, toDirectory(placeholder)];
  }
  return merged ?? directories;
}
