import { realpath } from "node:fs/promises";
import path from "node:path";
import type { NavigationDirectorySummary, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { canonicalizeNavigationPath, navigationPathIdentity } from "@pwragent/shared/directory-navigation";
import { compareThreadsByCreatedAtDesc } from "@pwragent/shared/thread-pins";

const DIRECTORY_PREFIX = "directory:";
const CASE_PROBE_BATCH_SIZE = 16;

type DirectoryCaseAliases = {
  directories: NavigationDirectorySummary[];
  directoryCaseAliases?: Record<string, string[]>;
};

/** Reconcile local rows at read time so historical draft/setting keys stay valid. */
export async function reconcileWindowsDirectoryAliases(
  directories: NavigationDirectorySummary[],
  threads: readonly NavigationThreadSummary[],
  signal?: AbortSignal,
): Promise<DirectoryCaseAliases> {
  if (process.platform !== "win32") return { directories };

  const candidates = new Map<string, NavigationDirectorySummary[]>();
  for (const directory of directories) {
    if (directory.kind !== "directory" || directory.localAvailability || directory.peerProject
      || !directory.key.startsWith(DIRECTORY_PREFIX)) continue;
    const reportedPath = directory.key.slice(DIRECTORY_PREFIX.length);
    if (!path.win32.isAbsolute(reportedPath)) continue;
    const identity = navigationPathIdentity(reportedPath, true);
    const group = candidates.get(identity);
    if (group) group.push(directory);
    else candidates.set(identity, [directory]);
  }
  const collisions = [...candidates.values()].filter((group) => group.length > 1).flat();
  if (!collisions.length) return { directories };

  const verified = new Map<string, { diskPath: string; rows: NavigationDirectorySummary[] }>();
  for (let start = 0; start < collisions.length; start += CASE_PROBE_BATCH_SIZE) {
    signal?.throwIfAborted();
    const results = await Promise.all(collisions.slice(start, start + CASE_PROBE_BATCH_SIZE).map(async (directory) => ({
      directory,
      diskPath: await realpath(directory.key.slice(DIRECTORY_PREFIX.length)).then(canonicalizeNavigationPath, () => undefined),
    })));
    for (const { directory, diskPath } of results) {
      if (!diskPath) continue;
      // Require both a spelling-only difference between keys and the same
      // case-sensitive filesystem answer. A junction target alone is not an alias.
      const identity = JSON.stringify([navigationPathIdentity(directory.key, true), diskPath]);
      const group = verified.get(identity);
      if (group) group.rows.push(directory);
      else verified.set(identity, { diskPath, rows: [directory] });
    }
  }
  signal?.throwIfAborted();
  const aliases = [...verified.values()].filter(({ rows }) => rows.length > 1);
  if (!aliases.length) return { directories };

  const orderedThreads = [...threads].sort(compareThreadsByCreatedAtDesc);
  const threadOrder = new Map(orderedThreads.map((thread, index) => [buildThreadIdentityKey(thread.source, thread.id), index]));
  const needsAttention = new Set(threads.filter((thread) => thread.inbox.inInbox)
    .map((thread) => buildThreadIdentityKey(thread.source, thread.id)));
  const rows = new Map(directories.map((directory) => [directory.key, directory]));
  const directoryCaseAliases: Record<string, string[]> = {};
  for (const { diskPath, rows: group } of aliases) {
    const diskKey = `${DIRECTORY_PREFIX}${diskPath}`;
    // Match registration's preference for the disk-spelled key when both
    // spellings have a saved launchpad. With one, honor its existing key.
    group.sort((left, right) => Number(Boolean(right.launchpad)) - Number(Boolean(left.launchpad))
      || Number(right.key === diskKey) - Number(left.key === diskKey)
      || (left.key < right.key ? -1 : 1));
    const preferred = group[0]!;
    const duplicates = group.slice(1);
    const threadKeys = [...new Set(group.flatMap((directory) => directory.threadKeys))]
      .sort((left, right) => (threadOrder.get(left) ?? Infinity) - (threadOrder.get(right) ?? Infinity));
    const checkoutPaths = [...new Set(group.flatMap((directory) => directory.checkoutPaths ?? []))];
    rows.set(preferred.key, {
      ...preferred,
      ...(checkoutPaths.length ? { checkoutPaths } : {}),
      threadKeys,
      needsAttentionCount: threadKeys.filter((key) => needsAttention.has(key)).length,
      latestUpdatedAt: group.reduce((latest, directory) => Math.max(latest, directory.latestUpdatedAt ?? 0), 0) || undefined,
    });
    directoryCaseAliases[preferred.key] = duplicates.map((duplicate) => duplicate.key);
    for (const duplicate of duplicates) rows.delete(duplicate.key);
  }
  return { directories: [...rows.values()], directoryCaseAliases };
}
