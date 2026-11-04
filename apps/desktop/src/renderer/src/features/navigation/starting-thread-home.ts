import {
  findRemoteHomeDirectoryIndex,
  isRemoteFederationTarget,
  type FederationRemoteTarget,
  type FederationTarget,
  type NavigationDirectorySummary,
  type NavigationLaunchpadDraft,
} from "@pwragent/shared";

/** What a starting row carries that decides where it renders. */
export type StartingThreadPlacement = {
  directoryKey: string;
  directoryLabel: string;
  launchpad: Pick<NavigationLaunchpadDraft, "directoryKind" | "directoryPath">;
  parentThreadKey?: string;
  target?: FederationTarget;
};

/**
 * The project row a starting thread lands in: the row its thread's row will
 * render in, so the starting row never moves when the thread arrives.
 *
 * A thread on the machine whose list this is lands in its launchpad's own
 * row. A peer's thread in this machine's list does not: its launchpad names
 * the peer's directory, keyed by the peer's path, and main files the thread
 * under a local project by `findRemoteHomeDirectoryIndex`. The starting row
 * asks that rule about the one directory the thread will link, even when the
 * peer's path happens to equal a local one, because main does too.
 *
 * Undefined when no project row will take it yet: a sub-thread whose parent
 * row is not here, or a peer project with no row here, which main adds when
 * the thread lands.
 */
export function startingThreadHomeDirectoryKey(
  creation: StartingThreadPlacement,
  directories: readonly Pick<NavigationDirectorySummary, "key" | "kind" | "label" | "localAvailability" | "path">[],
  /** The peer a federation window shows; absent in this machine's window. */
  windowTarget?: FederationRemoteTarget,
): string | undefined {
  const peerThreadInLocalList = creation.target
    && isRemoteFederationTarget(creation.target)
    && creation.target.instanceId !== windowTarget?.instanceId;
  // A sub-thread lands under its parent's row, not a project's.
  if (!peerThreadInLocalList || creation.parentThreadKey) {
    return directories.some((directory) => directory.key === creation.directoryKey)
      ? creation.directoryKey
      : undefined;
  }
  const path = creation.launchpad.directoryPath?.trim()
    || (creation.directoryKey.startsWith("directory:")
      ? creation.directoryKey.slice("directory:".length)
      : "");
  const index = creation.launchpad.directoryKind === "workspace"
    ? directories.findIndex((directory) => directory.kind === "workspace")
    : findRemoteHomeDirectoryIndex(directories, {
      linkedDirectories: path
        ? [{ id: creation.directoryKey, kind: "local", label: creation.directoryLabel, path }]
        : [],
    });
  return index === undefined || index < 0 ? undefined : directories[index]!.key;
}
