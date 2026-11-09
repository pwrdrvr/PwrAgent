import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { buildThreadIdentityKey } from "@pwragent/shared";
import { runGitCommand } from "./git-executable";
import type { ThreadArchiveCandidate } from "./thread-archive-sweeper";
import type { MaintenanceDiscoveryProgress } from "./unreferenced-worktrees";

/** A linked checkout is the cwd, not the primary repository named alongside it. */
export function candidateCheckoutDirectories(candidate: ThreadArchiveCandidate): string[] {
  const directories = [...candidate.thread.linkedDirectories, ...candidate.overlay?.extraLinkedDirectories ?? [],
    ...candidate.overlay?.retainedWorktrees ?? []];
  const values = directories.length ? directories.map((directory) => directory.worktreePath ?? directory.path)
    : [candidate.thread.projectKey];
  return [...new Set(values.filter((value): value is string => !!value && path.isAbsolute(value)).map((value) => path.normalize(value)))];
}

async function checkoutRoot(cwd: string): Promise<string | undefined> {
  try {
    if (!(await stat(cwd)).isDirectory()) return undefined;
    const { stdout } = await runGitCommand(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"], { timeout: 10_000 });
    const root = stdout.trim();
    return path.isAbsolute(root) ? await realpath(root) : undefined;
  } catch {
    // A known linked checkout can outlive its common repository. Retain its
    // allocation and thread association for the existing repository-gone review.
    try { if ((await lstat(path.join(cwd, ".git"))).isFile()) return await realpath(cwd); }
    catch { /* Missing or unreadable cwd is not an inspectable checkout. */ }
    return undefined;
  }
}

/** Resolve only provider-reported cwd paths. Never enumerate siblings, Git
 * registrations or other profiles to infer ownership from a directory name. */
export async function resolveOwnedMaintenanceCheckouts(
  candidates: readonly ThreadArchiveCandidate[],
  onProgress?: (progress: MaintenanceDiscoveryProgress) => void,
  resolve: (cwd: string) => Promise<string | undefined> = checkoutRoot,
): Promise<{ path: string; candidates: ThreadArchiveCandidate[] }[]> {
  const byCwd = new Map<string, ThreadArchiveCandidate[]>();
  for (const candidate of candidates) for (const cwd of candidateCheckoutDirectories(candidate)) {
    byCwd.set(cwd, [...byCwd.get(cwd) ?? [], candidate]);
  }
  const entries = [...byCwd];
  const resolved: { path: string; candidates: ThreadArchiveCandidate[] }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, entries.length) }, async () => {
    while (next < entries.length) {
      const [cwd, owners] = entries[next++]!;
      onProgress?.({ detail: "Resolving checkouts used by this profile's threads", root: cwd, found: resolved.length });
      const target = await resolve(cwd);
      if (target) resolved.push({ path: path.normalize(target), candidates: owners });
    }
  }));
  const checkouts = new Map<string, { path: string; owners: Map<string, ThreadArchiveCandidate> }>();
  for (const row of resolved) {
    const key = process.platform === "win32" ? row.path.toLowerCase() : row.path;
    let item = checkouts.get(key);
    if (!item) checkouts.set(key, item = { path: row.path, owners: new Map() });
    for (const candidate of row.candidates) item.owners.set(buildThreadIdentityKey(candidate.thread.source, candidate.thread.id), candidate);
  }
  return [...checkouts.values()].map((item) => ({ path: item.path, candidates: [...item.owners.values()] }));
}
