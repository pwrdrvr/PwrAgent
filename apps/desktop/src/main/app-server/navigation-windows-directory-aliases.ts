import { realpath } from "node:fs/promises";
import path from "node:path";
import type { NavigationDirectorySummary, NavigationThreadSummary, ProjectCheckoutGroup } from "@pwragent/shared/contracts/navigation";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { buildDirectorySummaries, canonicalizeNavigationPath, directoryIncludesCheckout, navigationPathIdentity } from "@pwragent/shared/directory-navigation";
import { compareThreadsByCreatedAtDesc } from "@pwragent/shared/thread-pins";

const DIRECTORY_PREFIX = "directory:";
const CASE_PROBE_BATCH_SIZE = 16;

type DirectoryCaseAliases = {
  directories: NavigationDirectorySummary[];
  directoryCaseAliases?: Record<string, string[]>;
};

type CaseCandidate = { key: string; directory: NavigationDirectorySummary };

function localDirectoryKeys(directory: NavigationDirectorySummary): string[] {
  return directory.kind === "directory" && !directory.localAvailability && !directory.peerProject
    ? [directory.key, ...(directory.checkoutPaths ?? []).map((checkout) => `${DIRECTORY_PREFIX}${checkout}`)]
    : [];
}

function readDirectoryRealPath(key: string): Promise<string | undefined> {
  return realpath(key.slice(DIRECTORY_PREFIX.length)).then(canonicalizeNavigationPath, () => undefined);
}

/** Find saved local keys that still resolve to the same Windows directory. */
export async function findWindowsDirectoryCaseAliases(key: string, keys: readonly string[]): Promise<string[]> {
  if (process.platform !== "win32" || !key.startsWith(DIRECTORY_PREFIX)
    || !path.win32.isAbsolute(key.slice(DIRECTORY_PREFIX.length))) return [];
  const identity = navigationPathIdentity(key, true);
  const variants = keys.filter((candidate) => candidate !== key && navigationPathIdentity(candidate, true) === identity);
  if (!variants.length) return [];
  const diskPath = await readDirectoryRealPath(key);
  if (!diskPath) return [];
  const aliases: string[] = [];
  for (const variant of variants) {
    if (await readDirectoryRealPath(variant) === diskPath) aliases.push(variant);
  }
  return aliases;
}

/** Project the reported checkout as if its thread had already been listed. */
export async function resolvePendingWindowsDirectoryKey(
  key: string,
  visibleDirectories: ReadonlyMap<string, NavigationDirectorySummary>,
  checkoutGroups?: readonly ProjectCheckoutGroup[],
): Promise<string | undefined> {
  if (process.platform !== "win32" || !key.startsWith(DIRECTORY_PREFIX)
    || !path.win32.isAbsolute(key.slice(DIRECTORY_PREFIX.length))) return undefined;
  const reportedKey = canonicalizeNavigationPath(key);
  const identity = navigationPathIdentity(reportedKey, true);
  const matches = (candidate: string) => navigationPathIdentity(candidate, true) === identity;
  const configuredProjects = buildDirectorySummaries({
    threads: [], checkoutGroups: checkoutGroups?.filter((group) =>
      group.paths.some((checkout) => matches(`${DIRECTORY_PREFIX}${checkout}`))),
  });
  const configuredKeys = new Set(configuredProjects.map((project) => project.key));
  const candidates = [...visibleDirectories.values()].filter((directory) =>
    !configuredKeys.has(directory.key) && (!checkoutGroups || !directory.checkoutPaths?.length)
    && localDirectoryKeys(directory).some(matches));
  candidates.push(...configuredProjects.map((project) => ({ ...visibleDirectories.get(project.key), ...project })));
  if (candidates.some((directory) => directoryIncludesCheckout(directory, reportedKey))) return undefined;
  if (!candidates.length) return undefined;

  candidates.push({
    key: reportedKey, kind: "directory", label: path.win32.basename(key.slice(DIRECTORY_PREFIX.length)),
    path: reportedKey.slice(DIRECTORY_PREFIX.length), threadKeys: [], needsAttentionCount: 0,
  });
  const { directoryCaseAliases } = await reconcileWindowsDirectoryAliases(
    candidates.map((directory) => ({ ...directory, caseAliasKeys: undefined })), [],
  );
  return Object.entries(directoryCaseAliases ?? {}).find(([, aliases]) => aliases.includes(reportedKey))?.[0];
}

/** Reconcile local rows at read time so historical draft/setting keys stay valid. */
export async function reconcileWindowsDirectoryAliases(
  directories: NavigationDirectorySummary[],
  threads: readonly NavigationThreadSummary[],
  signal?: AbortSignal,
): Promise<DirectoryCaseAliases> {
  if (process.platform !== "win32") return { directories };

  const candidates = new Map<string, CaseCandidate[]>();
  for (const directory of directories) {
    for (const key of new Set(localDirectoryKeys(directory))) {
      if (!key.startsWith(DIRECTORY_PREFIX) || !path.win32.isAbsolute(key.slice(DIRECTORY_PREFIX.length))) continue;
      const identity = navigationPathIdentity(key, true);
      const group = candidates.get(identity);
      const candidate = { key, directory };
      if (group) group.push(candidate);
      else candidates.set(identity, [candidate]);
    }
  }
  const collisions = [...candidates.values()].filter((group) => new Set(group.map(({ key }) => key)).size > 1).flat();
  if (!collisions.length) return { directories };

  const verified = new Map<string, { diskPath: string; candidates: CaseCandidate[] }>();
  for (let start = 0; start < collisions.length; start += CASE_PROBE_BATCH_SIZE) {
    signal?.throwIfAborted();
    const results = await Promise.all(collisions.slice(start, start + CASE_PROBE_BATCH_SIZE).map(async (candidate) => ({
      candidate,
      diskPath: await readDirectoryRealPath(candidate.key),
    })));
    for (const { candidate, diskPath } of results) {
      if (!diskPath) continue;
      // Require both a spelling-only difference between keys and the same
      // case-sensitive filesystem answer. A junction target alone is not an alias.
      const identity = JSON.stringify([navigationPathIdentity(candidate.key, true), diskPath]);
      const group = verified.get(identity);
      if (group) group.candidates.push(candidate);
      else verified.set(identity, { diskPath, candidates: [candidate] });
    }
  }
  signal?.throwIfAborted();
  const aliases = [...verified.values()].filter(({ candidates }) => candidates.length > 1);
  if (!aliases.length) return { directories };

  const orderedThreads = [...threads].sort(compareThreadsByCreatedAtDesc);
  const threadOrder = new Map(orderedThreads.map((thread, index) => [buildThreadIdentityKey(thread.source, thread.id), index]));
  const needsAttention = new Set(threads.filter((thread) => thread.inbox.inInbox)
    .map((thread) => buildThreadIdentityKey(thread.source, thread.id)));
  const rows = new Map(directories.map((directory) => [directory.key, directory]));
  const directoryCaseAliases: Record<string, string[]> = {};
  const projectKeyByAlias = new Map<string, string>();
  const currentProjectKey = (key: string) => projectKeyByAlias.get(key) ?? key;
  for (const { diskPath, candidates } of aliases) {
    const group = [...new Set(candidates.map(({ directory }) => currentProjectKey(directory.key)))].flatMap((key) => {
      const directory = rows.get(key);
      return directory ? [directory] : [];
    });
    if (group.length < 2) continue;
    const policyOwners = group.filter((directory) => directory.forgeAutomation);
    const checkoutGroups = group.filter((directory) => directory.checkoutPaths?.length);
    // Each policy and checkout group has its own editable storage key. Keep
    // independently configured records reachable until they can be reconciled.
    if (policyOwners.length > 1 || checkoutGroups.length > 1) continue;
    const diskKey = `${DIRECTORY_PREFIX}${diskPath}`;
    // Keep a saved Forge policy on the editable key, even when the
    // registration would otherwise favor the disk-spelled key.
    group.sort((left, right) => Number(Boolean(right.launchpad)) - Number(Boolean(left.launchpad))
      || Number(right.key === diskKey) - Number(left.key === diskKey)
      || (left.key < right.key ? -1 : 1));
    const checkoutGroup = checkoutGroups[0];
    const secondaryCheckout = checkoutGroup && candidates.some(({ key, directory }) =>
      currentProjectKey(directory.key) === checkoutGroup.key && key !== directory.key);
    // A secondary checkout points at the configured project. Preserve a
    // separately saved policy or registration until its owner reconciles it.
    if (secondaryCheckout && group.some((directory) => directory !== checkoutGroup
      && (directory.forgeAutomation || directory.launchpad))) continue;
    const preferred = (secondaryCheckout ? checkoutGroup : policyOwners[0]) ?? group[0]!;
    const duplicates = group.filter((directory) => directory !== preferred);
    const aliasKeys = [...new Set([...(preferred.caseAliasKeys ?? []), ...duplicates.flatMap((directory) =>
      [directory.key, ...(directory.caseAliasKeys ?? [])])])];
    const threadKeys = [...new Set(group.flatMap((directory) => directory.threadKeys))]
      .sort((left, right) => (threadOrder.get(left) ?? Infinity) - (threadOrder.get(right) ?? Infinity));
    rows.set(preferred.key, {
      ...preferred,
      ...(checkoutGroup ? {
        path: checkoutGroup.path, checkoutPaths: checkoutGroup.checkoutPaths,
        repositoryKey: checkoutGroup.repositoryKey ?? preferred.repositoryKey,
      } : {}),
      caseAliasKeys: aliasKeys,
      threadKeys,
      needsAttentionCount: threadKeys.filter((key) => needsAttention.has(key)).length,
      latestUpdatedAt: group.reduce((latest, directory) => Math.max(latest, directory.latestUpdatedAt ?? 0), 0) || undefined,
    });
    directoryCaseAliases[preferred.key] = aliasKeys;
    for (const alias of aliasKeys) projectKeyByAlias.set(alias, preferred.key);
    for (const duplicate of duplicates) {
      rows.delete(duplicate.key);
      delete directoryCaseAliases[duplicate.key];
    }
  }
  return Object.keys(directoryCaseAliases).length ? { directories: [...rows.values()], directoryCaseAliases } : { directories };
}
