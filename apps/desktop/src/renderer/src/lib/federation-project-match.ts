import type { DirectorySummaryKind } from "@pwragent/shared";

/** What it takes to recognize one project on two machines. */
export type ProjectIdentity = {
  kind: DirectorySummaryKind;
  label: string;
  path?: string;
  /** `host/owner/repo` from the checkout's origin, when the owner read one. */
  repositoryKey?: string;
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
export function directoryIdentityNames(directory: ProjectIdentity): string[] {
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
 * different origins are two different projects even when the names agree.
 * Only when either side has no origin does the name decide.
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
  const nameCandidates = localRepository
    ? candidates.filter((directory) => !directory.repositoryKey)
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
